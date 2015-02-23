'use strict';

var Q = require('q');
var should = require('should');
var backends = require('../lib/backends');

describe('backends test', function(){
	var testFunc = function(backend){
		var name = 'test', id = 1, doc = {k : 'v'};
		return Q.fcall(function(){
			return backend.start();
		})
		.then(function(){
			return backend.drop(name);
		})
		.then(function(){
			return backend.set(name, id, doc);
		})
		.then(function(){
			return backend.get(name, id)
			.then(function(ret){
				ret.should.eql(doc);
			});
		})
		.then(function(){
			return backend.del(name, id);
		})
		.then(function(){
			return backend.get(name, id)
			.then(function(ret){
				(ret === null).should.be.true; // jshint ignore:line
			});
		})
		.fin(function(){
			return Q.fcall(function(){
				return backend.drop(name);
			})
			.then(function(){
				return backend.stop();
			});
		});
	};

	it('mongo backend', function(cb){
		var backend = backends.create('mongodb', {uri : 'mongodb://localhost/memorydb-test'});
		return Q.fcall(function(){
			return testFunc(backend);
		})
		.done(function(){
			cb();
		});
	});

	it('redis backend', function(cb){
		var backend = backends.create('redis', {host : '127.0.0.1', port : 6379});
		return Q.fcall(function(){
			return testFunc(backend);
		})
		.done(function(){
			cb();
		});
	});
});

