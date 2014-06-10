Redis-ext extends nodejs redis client with failover support via Redis Sentinels.
It also provides basic job queue implementation.

## Usage

   Usage: create Sentinel aware connection
 ```
	var redis = require('redis-ext')
	, _sentinels = [
			{host: "localhost", port: 26379},
			{host: "localhost", port: 26380},
	]
	, _options = { retry_max_delay: 10000 }
	, client = redis.createWithSentinel(_sentinels, "mastername", _options);

 ```
   Usage: create receiving job client
 ```
	var queue = redis.createQueue(function () {
		return redis.createWithSentinel(_sentinels, "queues", _options);
	}, key, workerFn);

	queue.connect(); // start receiving jobs
 ```
   Usage: create job queue
 ```
	var queue = redis.createQueue(function () {
		return redis.createWithSentinel(_sentinels, "queues", _options);
	}, key, workerFn);

	queue.send(jobdescription);
 ```
 
## Author
Laura Doktorova @olado

## License
redis-ext is licensed under the MIT License. (See LICENSE-DOT)
