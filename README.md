Redis-ext extends nodejs redis client with failover support via Redis Sentinels.

It also provides basic job queue implementation.

## Installation
	npm install redis-ext
	
## Usage

   Create Sentinel aware connection:
 ```
	var redis = require('redis-ext')
	, _sentinels = [
			{host: "localhost", port: 26379},
			{host: "localhost", port: 26380},
	]
	/* possible options:
	* retry_delay - minimum delay before attempting to reconnect, delay will grow up to retry_max_delay of provided
	* retry_max_delay - maximum delay between reconnection attempts
	* connect_timeout - if specified, retries will stop after total time for reconnecting exceeds this number 
	*/
	, _options = { retry_max_delay: 10000 }
	, client = redis.createWithSentinel(_sentinels, "mastername", _options);

 ```
   Create receiving job client:
 ```
	var queue = redis.createQueue(function () {
		return redis.createWithSentinel(_sentinels, "queues", _options);
	}, key, workerFn);

	queue.connect(); // start receiving jobs
 ```
   Create job queue:
 ```
	var queue = redis.createQueue(function () {
		return redis.createWithSentinel(_sentinels, "queues", _options);
	}, key);

	queue.send(jobdescription);
 ```
 
## Author
Laura Doktorova @olado

## License
redis-ext is licensed under the MIT License
