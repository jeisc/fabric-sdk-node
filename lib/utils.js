/**
 * Copyright 2016 IBM All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *    http://www.apache.org/licenses/LICENSE-2.0
 *
 *  Unless required by applicable law or agreed to in writing, software
 *  distributed under the License is distributed on an "AS IS" BASIS,
 *  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 *  See the License for the specific language governing permissions and
 *  limitations under the License.
 */

'use strict';

var fs = require('fs');
var tar = require('tar-fs');
var grpc = require('grpc');
var path = require('path');
var zlib = require('zlib');
var urlParser = require('url');
var winston = require('winston');

//
// Load required crypto stuff.
//

var sha3_256 = require('js-sha3').sha3_256;

//
// Load required protobufs.
//

var _timeStampProto = grpc.load(__dirname + '/protos/google/protobuf/timestamp.proto').google.protobuf.Timestamp;

//
// The following methods are for loading the proper implementation of an extensible APIs.
//

module.exports.getCryptoSuite = function() {
	var cryptoSuite;

	var csEnv = process.env.CRYPTO_SUITE;
	if (csEnv) // expecting a path to an alternative Crypto Suite implementation
		cryptoSuite = require(csEnv);
	else
		cryptoSuite = require('./impl/CryptoSuite_ECDSA_SHA.js');

	return new cryptoSuite();
};

module.exports.newKeyValueStore = function(options) {
	var store;

	var kvsEnv = process.env.KEY_VALUE_STORE;
	if (kvsEnv) // expecting a path to an alternative KeyValueStore implementation
		store = require(kvsEnv);
	else
		store = require('./impl/FileKeyValueStore.js');

	return new store(options);
};

module.exports.getMemberService = function() {
	var ms;

	var msEnv = process.env.MEMBER_SERVICE;
	if (msEnv) // expecting a path to an alternative MemberService implementation
		ms = require(msEnv);
	else
		ms = require('./impl/MemberServices.js');

	return new ms();
};

//
// Other methods
//

//
// generateTimestamp returns the current time in the google/protobuf/timestamp.proto
// structure.
//
module.exports.generateTimestamp = function() {
	var timestamp = new _timeStampProto({ seconds: Date.now() / 1000, nanos: 0 });
	return timestamp;
};

const LOGGING_LEVELS = ['debug', 'info', 'warn', 'error'];

//
// Internal API.
//
// Get the standard logger to use throughout the SDK code. If the client application has
// configured a logger, then that'll be returned.
//
// The user can also make user of the built-in "winston" based logger and use the environment
// variable HFC_LOGGING to pass in configurations in the following format:
//
// {
//   'error': 'error.log',				// 'error' logs are printed to file 'error.log' relative of the current working dir for node.js
//   'debug': '/tmp/myapp/debug.log',	// 'debug' and anything more critical ('info', 'warn', 'error') can also be an absolute path
//   'info': 'console'					// 'console' is a keyword for logging to console
// }
//
module.exports.getLogger = function(name) {
	var saveLogger = function(logger) {
		if (global.hfc) {
			global.hfc.logger = logger;
		} else {
			global.hfc = {
				logger: logger
			};
		}
	};

	var newDefaultLogger = function() {
		return new winston.Logger({
			transports: [
				new (winston.transports.Console)({ colorize: true })
			]
		});
	};

	var insertLoggerName = function(originalLogger, lname) {
		var logger = Object.assign({}, originalLogger);

		['debug', 'info', 'warn', 'error'].forEach(function(method) {
			var func = originalLogger[method];

			logger[method] = (function(context, loggerName, f) {
				return function() {
					if (arguments.length > 0) {
						arguments[0] = '[' + loggerName + ']: ' + arguments[0];
					}

					f.apply(context, arguments);
				};
			})(originalLogger, lname, func);
		});

		return logger;
	};

	if (global.hfc && global.hfc.logger)
		return insertLoggerName(global.hfc.logger, name);

	var options = {};
	if (process.env.HFC_LOGGING) {
		try {
			var config = JSON.parse(process.env.HFC_LOGGING);

			if (typeof config !== 'object') {
				throw new Error('Environment variable "HFC_LOGGING" must be an object conforming to the format documented.');
			} else {
				for (var level in config) {
					if (!config.hasOwnProperty(level)) {
						continue;
					}

					if (LOGGING_LEVELS.indexOf(level) >= 0) {
						if (!options.transports) {
							options.transports = [];
						}

						if (config[level] === 'console') {
							options.transports.push(new (winston.transports.Console)({
								name: level + 'console',
								level: level,
								colorize: true
							}));
						} else {
							options.transports.push(new (winston.transports.File)({
								name: level + 'file',
								level: level,
								filename: config[level],
								colorize: true
							}));
						}
					}
				}
			}

			var logger = new winston.Logger(options);
			logger.info('Successfully constructed a winston logger with configurations', config);
			saveLogger(logger);
			return insertLoggerName(logger, name);
		} catch(err) {
			// the user's configuration from environment variable failed to parse.
			// construct the default logger, log a warning and return it
			var logger = newDefaultLogger();
			saveLogger(logger);
			logger.log('warn', 'Failed to parse environment variable "HFC_LOGGING". Returned a winston logger with default configurations. Error: %s', err.stack ? err.stack : err);
			return insertLoggerName(logger, name);
		}
	}

	var logger = newDefaultLogger();
	saveLogger(logger);
	logger.info('Returning a new winston logger with default configurations');
	return insertLoggerName(logger, name);
};

//
// generateParameterHash generates a hash from the chaincode deployment parameters.
// Specifically, it hashes together the code path of the chaincode (under $GOPATH/src/),
// the initializing function name, and all of the initializing parameter values.
//
module.exports.generateParameterHash = function(path, func, args) {
	// Append the arguments
	var argLength = args.length;
	var argStr = '';
	for (var i = 0; i < argLength; i++) {
		argStr = argStr + args[i];
	}

	// Append the path + function + arguments
	var str = path + func + argStr;

	// Compute the hash
	var strHash = sha3_256(str);

	return strHash;
};

//
// generateDirectoryHash generates a hash of the chaincode directory contents
// and hashes that together with the chaincode parameter hash, generated above.
//
module.exports.generateDirectoryHash = function(rootDir, chaincodeDir, hash) {
	var self = this;

	// Generate the project directory
	var projectDir = rootDir + '/' + chaincodeDir;

	// Read in the contents of the current directory
	var dirContents = fs.readdirSync(projectDir);
	var dirContentsLen = dirContents.length;

	// Go through all entries in the projet directory
	for (var i = 0; i < dirContentsLen; i++) {
		var current = projectDir + '/' + dirContents[i];

		// Check whether the entry is a file or a directory
		if (fs.statSync(current).isDirectory()) {
			// If the entry is a directory, call the function recursively.

			hash = self.generateDirectoryHash(rootDir, chaincodeDir + '/' + dirContents[i], hash);
		} else {
			// If the entry is a file, read it in and add the contents to the hash string

			// Read in the file as buffer
			var buf = fs.readFileSync(current);
			// Update the value to be hashed with the file content
			var toHash = buf + hash;
			// Update the value of the hash
			hash = sha3_256(toHash);
		}
	}

	return hash;
};

//
// generateTarGz creates a .tar.gz file from contents in the src directory and
// saves them in a dest file.
//
module.exports.generateTarGz = function(src, dest) {
	// A list of file extensions that should be packaged into the .tar.gz.
	// Files with all other file extenstions will be excluded to minimize the size
	// of the deployment transaction payload.
	var keep = [
		'.go',
		'.yaml',
		'.json',
		'.c',
		'.h'
	];

	return new Promise(function(resolve, reject) {
		// Create the pack stream specifying the ignore/filtering function
		var pack = tar.pack(src, {
			ignore: function(name) {
				// Check whether the entry is a file or a directory
				if (fs.statSync(name).isDirectory()) {
					// If the entry is a directory, keep it in order to examine it further
					return false;
				} else {
					// If the entry is a file, check to see if it's the Dockerfile
					if (name.indexOf('Dockerfile') > -1) {
						return false;
					}

					// If it is not the Dockerfile, check its extension
					var ext = path.extname(name);

					// Ignore any file who's extension is not in the keep list
					if (keep.indexOf(ext) === -1) {
						return true;
					} else {
						return false;
					}
				}
			}
		})
		.pipe(zlib.Gzip())
		.pipe(fs.createWriteStream(dest));

		pack.on('close', function() {
			return resolve(dest);
		});
		pack.on('error', function() {
			return reject(new Error('Error on fs.createWriteStream'));
		});
	});
};



//
// The Endpoint class represents a remote grpc or grpcs target
//
module.exports.Endpoint = class {
	constructor(url /*string*/ , pem /*string*/ ) {
		var purl = urlParser.parse(url, true);
		var protocol;
		if (purl.protocol) {
			protocol = purl.protocol.toLowerCase().slice(0, -1);
		}
		if (protocol === 'grpc') {
			this.addr = purl.host;
			this.creds = grpc.credentials.createInsecure();
		} else if (protocol === 'grpcs') {
			this.addr = purl.host;
			this.creds = grpc.credentials.createSsl(new Buffer(pem));
		} else {
			var error = new Error();
			error.name = 'InvalidProtocol';
			error.message = 'Invalid protocol: ' + protocol + '.  URLs must begin with grpc:// or grpcs://';
			throw error;
		}
	}
};

//
// Other miscellaneous methods
//

module.exports.bitsToBytes = function(arr) {
	var out = [],
		bl = sjcl.bitArray.bitLength(arr),
		i, tmp;
	for (i = 0; i < bl / 8; i++) {
		if ((i & 3) === 0) {
			tmp = arr[i / 4];
		}
		out.push(tmp >>> 24);
		tmp <<= 8;
	}
	return out;
};

module.exports.bytesToBits = function(bytes) {
	var out = [],
		i, tmp = 0;
	for (i = 0; i < bytes.length; i++) {
		tmp = tmp << 8 | bytes[i];
		if ((i & 3) === 3) {
			out.push(tmp);
			tmp = 0;
		}
	}
	if (i & 3) {
		out.push(sjcl.bitArray.partial(8 * (i & 3), tmp));
	}
	return out;
};

module.exports.zeroBuffer = function(length) {
	var buf = new Buffer(length);
	buf.fill(0);
	return buf;
};

// utility function to convert Node buffers to Javascript arraybuffer
module.exports.toArrayBuffer = function(buffer) {
	var ab = new ArrayBuffer(buffer.length);
	var view = new Uint8Array(ab);
	for (var i = 0; i < buffer.length; ++i) {
		view[i] = buffer[i];
	}
	return ab;
};

// utility function to check if directory or file exists
// uses entire / absolute path from root
module.exports.existsSync = function(absolutePath /*string*/) {
	try  {
		var stat = fs.statSync(absolutePath);
		if (stat.isDirectory() || stat.isFile()) {
			return true;
		} else
			return false;
	}
	catch (e) {
		return false;
	}
};

