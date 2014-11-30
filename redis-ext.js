// redis-ext.js
// 2014, Laura Doktorova, https://github.com/olado/redis-ext
// Licensed under the MIT license.
var redis = require('redis')
	, RedisClient = redis.RedisClient
	, net = require('net')
	, debug = require('debug')('redis-ext')
	, debugjobs = require('debug')('jobs:redis-ext')
	;

//redis.debug_mode = true;
redis.Sentinel = Sentinel;
redis.Queue = Queue;

module.exports = redis;

redis.createWithSentinel = function (sentinels, master, options) {
	debug("create client with sentinel " + master);
	return new Sentinel(sentinels).createClient(master, options);
};

redis.createQueue = function(client, queuekey, workFn) {
	return new Queue(client, queuekey, workFn);
};

/*****************************************************************************
 * Seemless sentinel support with auto-reconnect
 *****************************************************************************/
function Sentinel(sentinels) {
	this.sentinels = sentinels;
};

Sentinel.prototype.createClient = function(master, options) {
	var self = this
		, stream = new net.Socket()
		, client = new RedisClient(stream, {max_attempts:1})
		, retry_max_delay = +(options && options.retry_max_delay) || 5*60*1000
		, retry_min_delay = +(options && options.retry_delay) || 100
		, retry_max_total = +(options && options.connect_timeout) || undefined
		, retry_delay = retry_min_delay
		, retry_total_time = 0
		;

	client.keepalive = true;

	client.on("connect", function () {
		retry_delay = retry_min_delay;
		retry_total_time = 0;
	});

	// must be listened for to prevent exceptions, do not remove
	client.on("error", function(err) {
		debug("connection error: " + master + " " + client.host + ":" + client.port + ": " + err);
	});

	if (debug.enabled) {
		client.on("ready", function() {
			debug("connected OK " + master);
		});

		client.on("end", function (err) {
			debug("connection ended " + master);
		});
	}

	client.quit = function() {
		client.keepalive = false;
		RedisClient.prototype.quit.call(client);
	};

	client.return_error = function (err) {
		RedisClient.prototype.return_error.call(client, err);

		if (client.keepalive && !client.closing && !client.connecting
			&& err && err.message && err.message.toLowerCase().indexOf("read only slave") !== -1) {
			client.connection_gone("error");
		}
	};

	client.connection_gone = function(why) {
		debug("in connection gone " + master + " - " + why + " for " + client.host + ":" + client.port + ". Is closing? " + client.closing);
		if (client.keepalive && !client.closing
			&& (why === 'error' || why === 'end' || why === 'close')) {
			if (!client.connecting) {
				retry_delay = Math.min(Math.floor(retry_delay * 1.7), retry_max_delay);
				retry_total_time += retry_delay;
				if (retry_max_total !== undefined && retry_total_time > retry_max_total) {
					return RedisClient.prototype.connection_gone.call(client, why);
				} else {
					debug("retrying " + master + " in " + retry_delay + " ms");
					client.connecting = setTimeout(connect, retry_delay);
				}
			}
		} else {
			return RedisClient.prototype.connection_gone.call(client, why);
		}
	};

	function connect() {
		self.getMaster(master, function (err, host, port) {
			if (client.connecting) {
				clearTimeout(client.connecting);
				client.connecting = undefined;
			}
			debug("in connect " + master + ": " + err + " " + host + ":" + port + " " + client.closing + " " + client.connected);
			if (!client.closing) {
				if (err || !host || !port) {
					debug("SENTINEL ERROR, what happens next?");
					client.on_error("sentinel error");
				} else {
					client.host = host;
					client.port = port;
					client.stream.connect(port, host);
				}
			}
		});
	}

	connect();

	return client;
};

Sentinel.prototype.getMaster = function(master, callback) {
	var total = this.sentinels.length, index = -1, self = this;

	// sequential as per http://redis.io/topics/sentinel-clients
	function done(err, host, port) {
		debug("in done for " + master + ": " + (err && err.message || '') + " " + host + ":" + port + " , index: " + index );

		if (err || !host || !port) {
			if (++index < total) {
				getMasterFromSentinel(self.sentinels[index], master, done);
			} else callback(err);
		} else {
			if (index) {
				var failed = self.sentinels[0];
				self.sentinels[0] = self.sentinels[index];
				self.sentinels[index] = failed;
			}
			callback(null, host, port);
			return;
		}
	}

	done();
};

function getMasterFromSentinel(endpoint, master, callback) {
	var callbackSent = false
		, sentinelClient = redis.createClient(endpoint.port, endpoint.host, {max_attempts:1});

	sentinelClient.on("error", function(err) {
		debug("error on talking to sentinel " + endpoint.host + " for " + master + ", " + callbackSent);
		if (!callbackSent) {
			callbackSent = true;
			callback(err);
		}
		sentinelClient.end();
	});

	sentinelClient.send_command('SENTINEL', ['get-master-addr-by-name', master], function(err, result) {
		if (callbackSent) return;

		callbackSent = true;
		if (err) return callback(err);
		if (result) return callback(null, result[0], result[1]);

		callback(new Error("Unkown master name: " + master));
	});

	sentinelClient.quit();
}

/*****************************************************************************
 * Queue - auto-reconnecting queue
 * 	connect
 * 	send
 * 	urgent
 * 	close
 *****************************************************************************/
function Queue(client, key, workFn, options) {
	if (typeof client === 'function') {
		this.clientFn = client;
	} else {
		this.client = client;
	}
	this.queueKey = key;
	if (workFn) {
		this.workFn = workFn;
		this.timeout = (options && options.timeout || 5000)/1000;
	}
}

Queue.prototype.close = function() {
	if (this.client) this.client.quit();
};

Queue.prototype.send = function(msg) {
	this.client.rpush(this.queueKey, msg);
};

Queue.prototype.urgent = function(msg) {
	this.client.lpush(this.queueKey, msg);
};

Queue.prototype.connect = function() {
	var self = this;
	if (this.clientFn) {
		if (this.client) this.client.quit();
		this.client = this.clientFn();
	}

	var client = this.client;
	// must be listened for to prevent exceptions, do not remove
	client.on("error", function (err) {
		debug(self.queueKey + ": Error " + err);

		if (err && err._source === "worker") {
			// if we reached here, throw it up
			// you can listen for "workererror" to prevent this from happening
			throw err;
		}
	});

	if (debug.enabled) {
		client.on("connect", function () {
			debug("connected to queue " + self.queueKey + " @ " + client.host + ":" + client.port);
		});

		client.on("end", function (err) {
			debug("connection to queue " + self.queueKey + " closed;" + (err ? " error: " + err : ""));
		});
	}

	client.on("ready", function () {
		if (self.workFn) {
			debug("ready to accept jobs " + self.queueKey);
			nextJob();
		} else {
			debug("ready to send jobs " + self.queueKey);
		}
	});

	if (this.workFn) {
		function nextJob() {
			client.blpop(self.queueKey, self.timeout, function (err, replies) {
				if (err) {
					if (debugjobs.enabled) debugjobs("error on next job " + self.queueKey + " " + err);
				} else if (replies && replies[1]) {
					if (debugjobs.enabled) debugjobs(self.queueKey + "  >" + replies[1]);
					// node_redis has a try/catch block and emits an "error" event
					try {
						self.workFn.call(null, replies[1]);
					} catch(callbackerr) {
						if (!client.emit("workererror", callbackerr)) {
							// If nobody cares we throw an exception here and then
							// from on("error") above and further jobs won't be processed
							callbackerr._source = "worker";
							throw callbackerr;
						}
					}
				}
				if (!client.closing) setImmediate(nextJob);
			});
		}
	}

	return client;
};


