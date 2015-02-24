'use strict';

var Q = require('q');
var _ = require('lodash');
var should = require('should');
var env = require('./env');
var Shard = require('../lib/shard');
var logger = require('pomelo-logger').getLogger('test', __filename);

describe('shard test', function(){
	beforeEach(function(cb){
		env.flushdb(cb);
	});
	after(function(cb){
		env.flushdb(cb);
	});

	it('load/unload/find/update/insert/remove/commit/rollback', function(cb){
		var shard = new Shard({
			_id : 's1',
			redisConfig : env.redisConfig,
			backend : 'mongodb',
			backendConfig : env.mongoConfig,
		});
		var connId = 'c1', key = 'user:1', doc = {_id : '1', name : 'rain', age : 30};

		return Q.fcall(function(){
			return shard.start();
		})
		.then(function(){
			// pre create collection for performance
			return Q.ninvoke(shard.backend.connection, 'createCollection', 'user');
		})
		.then(function(){
			// should auto load
			return shard.lock(connId, key);
		})
		.then(function(){
			shard._isLoaded(key).should.eql(true);

			// insert doc
			return shard.insert(connId, key, doc);
		})
		.then(function(){
			// request to unload doc
			shard.emit('request:' + key);
		})
		.delay(20)
		.then(function(){
			// should still loaded, waiting for commit
			shard._isLoaded(key).should.eql(true);

			return shard.commit(connId, key);
		})
		.delay(100)
		.then(function(){
			// should unloaded now and saved to backend
			shard._isLoaded(key).should.eql(false);

			// auto load again
			return shard.find(connId, key)
			.then(function(ret){
				// should read saved data
				ret.should.eql(doc);
			});
		})
		.then(function(){
			// Already loaded, should return immediately
			shard.find(connId, key).should.eql(doc);

			// load again for write
			return shard.lock(connId, key);
		})
		.then(function(){
			shard.update(connId, key, {age : 31});
			shard.find(connId, key, 'age').age.should.eql(31);

			// rollback to original value
			shard.rollback(connId, key);
			shard.find(connId, key, 'age').age.should.eql(30);

			return shard.lock(connId, key);
		})
		.then(function(){
			shard.remove(connId, key);
			(shard.find(connId, key) === null).should.be.true; // jshint ignore:line
			shard.commit(connId, key);
		})
		.then(function(){
			// request to unload
			shard.emit('request:' + key);
		})
		.delay(100)
		.then(function(){
			// load again
			return shard.find(connId, key)
			.then(function(ret){
				(ret === null).should.be.true; // jshint ignore:line
			});
		})
		.then(function(){
			return shard.stop();
		})
		.done(function(){
			cb();
		});
	});

	it('backendLock between multiple shards', function(cb){
		var shard1 = new Shard({
			_id : 's1',
			redisConfig : env.redisConfig,
			backend : 'mongodb',
			backendConfig : env.mongoConfig,
			unloadDelay : 500, // This is required for this test
		});
		var shard2 = new Shard({
			_id : 's2',
			redisConfig : env.redisConfig,
			backend : 'mongodb',
			backendConfig : env.mongoConfig,
		});

		var key = 'user:1', doc = {_id : '1', name : 'rain', age : 30};
		return Q.fcall(function(){
			return Q.all([shard1.start(), shard2.start()]);
		})
		.then(function(){
			// pre create collection for performance
			return Q.ninvoke(shard1.backend.connection, 'createCollection', 'user');
		})
		.then(function(){
			return Q.all([
				// shard1:c1
				Q.fcall(function(){
					// load by shard1
					return shard1.lock('c1', key);
				})
				.delay(100) // wait for shard2 request
				.then(function(){
					// should unloading now (wait for unlock)
					// already locked, so will not block
					return shard1.lock('c1', key);
				}).then(function(){
					shard1.insert('c1', key, doc);
					shard1.commit('c1', key);
					// unlocked, unloading should continue
				}),

				// shard2:c1
				Q() // jshint ignore:line
				.delay(20) // shard1 should load first
				.then(function(){
					// This will block until shard1 unload the key
					return shard2.find('c1', key);
				})
				.then(function(ret){
					ret.should.eql(doc);
					return shard2.lock('c1', key);
				})
				.then(function(){
					shard2.remove('c1', key);
					shard2.commit('c1', key);
				}),

				// shard1:c2
				Q() // jshint ignore:line
				.delay(50)
				.then(function(){
					// since shard1 is unloading, lock will block until unloaded
					// and then will load again (after shard2 unload)
					return shard1.lock('c2', key);
				})
				.then(function(){
					// should read shard2 saved value
					(shard1.find('c2', key) === null).should.be.true; // jshint ignore:line
				})
			]);
		})
		.then(function(){
			return Q.all([shard1.stop(), shard2.stop()]);
		})
		.done(function(){
			cb();
		});
	});

	it('force unload from broken shards', function(cb){
		var shard1 = new Shard({
			_id : 's1',
			redisConfig : env.redisConfig,
			backend : 'mongodb',
			backendConfig : env.mongoConfig,
		});
		var shard2 = new Shard({
			_id : 's2',
			redisConfig : env.redisConfig,
			backend : 'mongodb',
			backendConfig : env.mongoConfig,
			autoUnlockTimeout : 500,
		});

		var key = 'user:1', doc = {_id : '1', name : 'rain', age : 30};
		return Q.fcall(function(){
			return Q.all([shard1.start(), shard2.start()]);
		})
		.then(function(){
			return Q.all([
				// shard1
				Q.fcall(function(){
					return shard1.lock('c1', key);
				})
				.delay(1000) // Oops! program hang
				.then(function(){
					// Actually, backendLock is already released
					// Data is not consistent now
					shard1.insert('c1', key, doc);
					shard1.commit('c1', key);

					// Will discover the inconsistency and force unload the doc
					return shard1._saveAll();
				})
				.delay(100),

				// shard2
				Q() // jshint ignore:line
				.delay(50)
				.then(function(){
					return shard2.find('c1', key);
					// will autoUnlock since shard1 is hang
				})
				.then(function(ret){
					(ret === null).should.be.true; // jshint ignore:line
				})
			]);
		})
		.then(function(){
			return Q.all([shard1.stop(), shard2.stop()]);
		})
		.done(function(){
			cb();
		});
	});

	it('doc idle', function(cb){
		var shard = new Shard({
			_id : 's1',
			redisConfig : env.redisConfig,
			backend : 'mongodb',
			backendConfig : env.mongoConfig,
			docIdleTimeout : 100,
		});

		var key = 'user:1';
		return Q.fcall(function(){
			return shard.start();
		})
		.then(function(){
			return shard.find('c1', key);
		})
		.delay(200) //Doc idle timed out, should unloaded
		.then(function(){
			shard._isLoaded(key).should.eql(false);
			return shard.stop();
		})
		.done(function(){
			cb();
		});
	});
});
