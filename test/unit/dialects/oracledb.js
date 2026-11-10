const { expect } = require('chai');
const sinon = require('sinon');
const oracledb = require('oracledb');
const Oracle_Client = require('../../../lib/dialects/oracledb');
const {
  NameHelper,
  isConnectionError,
} = require('../../../lib/dialects/oracle/utils');
const {
  monkeyPatchConnection,
} = require('../../../lib/dialects/oracledb/utils');

// Passing a connection loads the real driver; max 0 skips building a pool.
const clientWithDriver = (connection = {}) =>
  new Oracle_Client({ client: 'oracledb', connection, pool: { max: 0 } });

const expectRejection = async (promise, expected) => {
  try {
    await promise;
    expect.fail('Expected the promise to reject.');
  } catch (thrown) {
    expect(thrown).to.equal(expected);
  }
};

const driverError = (message) =>
  Object.assign(new Error(message), { code: message.slice(0, 7) });

describe('OracleDB Unit Tests', () => {
  describe('Client', () => {
    describe('Version Parsing', () => {
      const fakeBadVersionQueryConnection = {
        execute: function () {
          const cb = arguments[arguments.length - 1];
          cb(null, {
            rows: [
              [
                'Oracle Database Bad Version String That Should Not Happen Unless Something Is Very Wrong',
              ],
            ],
          });
        },
      };

      it('should set its version to null if version in options is invalid', () => {
        const client = new Oracle_Client({
          client: 'oracledb',
          version: 'invalid',
        });

        expect(client.version).to.be.null;
      });

      it('should return the version provided in options if given from .checkVersion()', async () => {
        const client = new Oracle_Client({
          client: 'oracledb',
          version: '1.13',
        });
        const version = await client.checkVersion();

        expect(version).to.equal(client.version);
      });

      it('should strip off any character suffixes from versions', () => {
        const client = new Oracle_Client({
          client: 'oracledb',
          version: '12c',
        });
        expect(client.version).to.equal('12');
      });

      it('should error indicating the need to specify a version if it could not be auto-detected', async () => {
        const client = new Oracle_Client({ client: 'oracledb' });
        try {
          await client.checkVersion(fakeBadVersionQueryConnection);
          expect.fail('.checkVersion should have rejected.');
        } catch (err) {
          expect(err.message).to.match(
            /^Unable to detect .* version .* specify the version/
          );
        }
      });

      it('should require a valid version if it could not be auto-detected and provided version is invalid', async () => {
        const client = new Oracle_Client({
          client: 'oracledb',
          version: 'bad version',
        });
        try {
          await client.checkVersion(fakeBadVersionQueryConnection);
          expect.fail('.checkVersion should have rejected.');
        } catch (err) {
          expect(err.message).to.match(
            /^Invalid .* version number .* Unable to successfully auto-detect/
          );
        }
      });
    });
  });

  describe('Name Generation', () => {
    it('should use a 128 character name limit for Oracle 12.2 and above', () => {
      const ora122NameHelper = new NameHelper('12.2');
      const oraNameHelper = new NameHelper('18');

      expect(ora122NameHelper.limit).to.equal(128);
      expect(oraNameHelper.limit).to.equal(128);
    });

    it('should use a 30 character name limit for Oracle 12.1 and below', () => {
      const ora121NameHelper = new NameHelper('12.1');
      const ora11NameHelper = new NameHelper('11.3');

      expect(ora121NameHelper.limit).to.equal(30);
      expect(ora11NameHelper.limit).to.equal(30);
    });
  });

  describe('Connection Errors', () => {
    it('treats a Thin mode broken connection (NJS-500) as a connection error', () => {
      const err = driverError(
        'NJS-500: connection to the Oracle Database was broken'
      );
      expect(isConnectionError(err)).to.be.true;
    });

    // oracledb 6 Thin wraps socket errors in NJS-500 with the cause appended.
    it('treats a wrapped Thin mode socket error as a connection error', () => {
      const err = driverError(
        'NJS-500: connection to the Oracle Database was broken\n' +
          'NJS-521: connection to host db.example.com port 1521 received end-of-file on communication channel. (CONNECTION_ID=abc)'
      );
      expect(isConnectionError(err)).to.be.true;
    });

    it('treats an unwrapped NJS-521 as a connection error', () => {
      const err = driverError(
        'NJS-521: connection to host db.example.com port 1521 received end-of-file on communication channel. (CONNECTION_ID=abc)'
      );
      expect(isConnectionError(err)).to.be.true;
    });

    it('treats a session ended by the server (NJS-513) as a connection error', () => {
      const err = driverError(
        'NJS-513: error received through in-band notification: ORA-28'
      );
      expect(isConnectionError(err)).to.be.true;
    });

    // An ordinary SQL error must not throw away a healthy pooled connection.
    it('does not treat a SQL error as a connection error', () => {
      const err = driverError('ORA-00942: table or view does not exist');
      expect(isConnectionError(err)).to.be.false;
    });

    it('marks the connection disposed when a query fails with NJS-500', async () => {
      const client = clientWithDriver();
      const err = driverError(
        'NJS-500: connection to the Oracle Database was broken'
      );
      const connection = {
        execute: (sql, bindings, options, cb) => cb(err),
        close: () => Promise.resolve(),
      };
      monkeyPatchConnection(connection, client);

      try {
        await connection.executeAsync('select 1 from dual', [], {});
        expect.fail('executeAsync should have rejected.');
      } catch (thrown) {
        expect(thrown).to.equal(err);
      }
      expect(connection.__knex__disposed).to.equal(err);
    });

    const failingCommitConnection = (method, err) => {
      const connection = {
        execute: () => {},
        close: sinon.stub().resolves(),
        [method]: (cb) => cb(err),
      };
      monkeyPatchConnection(connection, clientWithDriver());
      return connection;
    };

    it('marks the connection disposed when a commit fails with NJS-500', async () => {
      const err = driverError(
        'NJS-500: connection to the Oracle Database was broken'
      );
      const connection = failingCommitConnection('commit', err);

      await expectRejection(connection.commitAsync(), err);
      expect(connection.__knex__disposed).to.equal(err);
      expect(connection.close.calledOnce).to.be.true;
    });

    it('marks the connection disposed when a rollback fails with NJS-500', async () => {
      const err = driverError(
        'NJS-500: connection to the Oracle Database was broken'
      );
      const connection = failingCommitConnection('rollback', err);

      await expectRejection(connection.rollbackAsync(), err);
      expect(connection.__knex__disposed).to.equal(err);
    });

    // A deferred constraint failing at commit leaves the session usable.
    it('keeps the connection when a commit fails with a SQL error', async () => {
      const err = driverError(
        'ORA-02091: transaction rolled back\nORA-02291: integrity constraint violated'
      );
      const connection = failingCommitConnection('commit', err);

      await expectRejection(connection.commitAsync(), err);
      expect(connection.__knex__disposed).to.be.undefined;
      expect(connection.close.called).to.be.false;
    });
  });

  describe('Connection Validation', () => {
    const client = new Oracle_Client({ client: 'oracledb' });

    it('accepts a connection whose socket is healthy', () => {
      expect(client.validateConnection({ isHealthy: () => true })).to.be.true;
    });

    it('rejects a connection whose socket has been closed', () => {
      expect(client.validateConnection({ isHealthy: () => false })).to.be.false;
    });

    // isHealthy() arrived in oracledb 5.4, and the fork still supports older drivers.
    it('accepts a connection from a driver without isHealthy', () => {
      expect(client.validateConnection({})).to.be.true;
    });
  });

  describe('Connection Options', () => {
    const acquireWith = async (connectionSettings) => {
      const client = clientWithDriver({
        user: 'u',
        password: 'p',
        ...connectionSettings,
      });
      const getConnection = sinon
        .stub(client.driver, 'getConnection')
        .callsFake((config, cb) => cb(null, {}));
      try {
        await client.acquireRawConnection();
        return getConnection.firstCall.args[0];
      } finally {
        getConnection.restore();
      }
    };

    it('passes expireTime through to the driver', async () => {
      const config = await acquireWith({
        connectString: 'db.example.com/SERVICE',
        expireTime: 2,
      });
      expect(config.expireTime).to.equal(2);
    });

    it('leaves expireTime out when it is not configured', async () => {
      const config = await acquireWith({
        connectString: 'db.example.com/SERVICE',
      });
      expect(config).to.not.have.property('expireTime');
    });

    // Knexfiles often write `process.env.X ? Number(process.env.X) : null`, and
    // oracledb rejects a null expireTime on every connect.
    it('leaves expireTime out when it is null', async () => {
      const config = await acquireWith({
        connectString: 'db.example.com/SERVICE',
        expireTime: null,
      });
      expect(config).to.not.have.property('expireTime');
    });

    // Zero is how oracledb turns prefetching off, so it must not be dropped as falsy.
    it('passes a prefetchRowCount of 0 through to the driver', async () => {
      const config = await acquireWith({
        connectString: 'db.example.com/SERVICE',
        prefetchRowCount: 0,
      });
      expect(config.prefetchRows).to.equal(0);
    });

    // require('oracledb') is shared by every test in the process, so a leftover
    // stub would hand later Oracle integration tests fake connections.
    it('leaves the shared oracledb driver unchanged', async () => {
      await acquireWith({ connectString: 'db.example.com/SERVICE' });
      expect(Object.prototype.hasOwnProperty.call(oracledb, 'getConnection')).to
        .be.false;
    });
  });
});
