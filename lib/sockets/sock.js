
/**
 * Module dependencies.
 */

var Emitter = require('events').EventEmitter;
var Configurable = require('../configurable');
var debug = require('debug')('axon:sock');
var Message = require('@shimaore/amp-message');
var Parser = require('@shimaore/amp').Stream;
var url = require('url');
var net = require('net');
var fs = require('fs');
var tls = require('tls');
/**
 * Errors to ignore.
 */

var ignore = [
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENETDOWN',
  'EPIPE',
  'ENOENT'
];

/**
 * Expose `Socket`.
 */

module.exports = Socket;

/**
 * Initialize a new `Socket`.
 *
 * A "Socket" encapsulates the ability of being
 * the "client" or the "server" depending on
 * whether `connect()` or `bind()` was called.
 *
 * @api private
 */

function Socket() {
  this.server = null;
  this.socks = [];
  this.settings = {};
  this.set('hwm', Infinity);
  this.set('identity', String(process.pid));
  this.set('retry timeout', 100);
  this.set('retry max timeout', 5000);
}

/**
 * Inherit from `Emitter.prototype`.
 */

Socket.prototype.__proto__ = Emitter.prototype;

/**
 * Make it configurable `.set()` etc.
 */

Configurable(Socket.prototype);

/**
 * Use the given `plugin`.
 *
 * @param {Function} plugin
 * @api private
 */

Socket.prototype.use = function(plugin){
  plugin(this);
  return this;
};

/**
 * Creates a new `Message` and write the `args`.
 *
 * @param {Array} args
 * @return {Buffer}
 * @api private
 */

Socket.prototype.pack = function(args){
  var msg = new Message(args);
  return msg.toBuffer();
};

/**
 * Close all open underlying sockets.
 *
 * @api private
 */

Socket.prototype.closeSockets = function(fn){
  debug('%s closing %d connections', this.type, this.socks.length);
  var i = this.socks.length;
  if (!i) {
    return fn();
  }
  this.socks.forEach(function(sock){
    if (fn) {
      sock.on('end', function listener(){
        sock.removeListener('close', listener);
        --i || fn();
      });
    }
    sock.end();
  });
};

/**
 * Close the socket.
 *
 * Delegates to the server or clients
 * based on the socket `type`.
 *
 * @param {Function} [fn]
 * @api public
 */

Socket.prototype.close = function(fn){
  debug('%s closing', this.type);
  this.closing = true;
  var i = this.server ? 2 : 1;
  this.closeSockets(function(err) {
    if (err) {
      return fn && fn(err);
    }
    --i || fn && fn();
  });
  if (this.server) this.closeServer(function(err) {
    if (err) {
      return fn && fn(err);
    }
    --i || fn && fn();
  });
};

/**
 * Close the server.
 *
 * @param {Function} [fn]
 * @api public
 */

Socket.prototype.closeServer = function(fn){
  debug('%s closing server', this.type);
  this.server.on('close', this.emit.bind(this, 'close'));
  this.server.close(fn);
};

/**
 * Return the server address.
 *
 * @return {Object}
 * @api public
 */

Socket.prototype.address = function(){
  if (!this.server) return;
  var addr = this.server.address();
  addr.string = (this.get('tls') ? 'tls://' : 'tcp://') + addr.address + ':' + addr.port;
  return addr;
};

/**
 * Remove `sock`.
 *
 * @param {Socket} sock
 * @api private
 */

Socket.prototype.removeSocket = function(sock){
  var i = this.socks.indexOf(sock);
  if (!~i) return;
  debug('%s remove socket %d', this.type, i);
  this.socks.splice(i, 1);
};

/**
 * Add `sock`.
 *
 * @param {Socket} sock
 * @api private
 */

Socket.prototype.addSocket = function(sock){
  var parser = new Parser;
  var i = this.socks.push(sock) - 1;
  debug('%s add socket %d', this.type, i);
  sock.pipe(parser);
  parser.on('data', this.onmessage(sock));
};

/**
 * Keep TCP connection alive
 * This allows detection of dead far-end.
 *
 * @api private
 */

Socket.prototype.keepalive = function(sock){
  var msg = new Message();
  var ping = msg.toBuffer();
  var keepalive = setInterval( function () {
    sock.write(ping);
  }, 1000);
  sock.on('close', function () {
    clearInterval(keepalive);
  });
}

/**
 * Handle `sock` errors.
 *
 * Emits:
 *
 *  - `error` (err) when the error is not ignored
 *  - `ignored error` (err) when the error is ignored
 *  - `socket error` (err) regardless of ignoring
 *
 * @param {Socket} sock
 * @api private
 */

Socket.prototype.handleErrors = function(sock){
  var self = this;
  sock.on('error', function(err){
    debug('%s error %s', self.type, err.code || err.message);
    self.emit('socket error', err);
    self.removeSocket(sock);
    if (!~ignore.indexOf(err.code)) return self.emit('error', err);
    debug('%s ignored %s', self.type, err.code);
    self.emit('ignored error', err);
  });
};

/**
 * Handles framed messages emitted from the parser, by
 * default it will go ahead and emit the "message" events on
 * the socket. However, if the "higher level" socket needs
 * to hook into the messages before they are emitted, it
 * should override this method and take care of everything
 * it self, including emitted the "message" event.
 *
 * @param {net.Socket} sock
 * @return {Function} closure(msg, mulitpart)
 * @api private
 */

Socket.prototype.onmessage = function(sock){
  var self = this;
  return function(buf){
    var msg = new Message(buf);
    self.emit('message',...msg.args);
  };
};

/**
 * Connect to `port` at `host` and invoke `fn()`.
 *
 * Defaults `host` to localhost.
 *
 * TODO: needs big cleanup
 *
 * @param {Number|String} port
 * @param {String} host
 * @param {Function} fn
 * @return {Socket}
 * @api public
 */

Socket.prototype.connect = function(port, host, fn){
  var self = this;
  if ('server' == this.type) throw new Error('cannot connect() after bind()');
  if ('function' == typeof host) {
    fn = host;
    host = undefined;
  }

  var tcpOpts = {};
  if ('string' == typeof port) {
    parsed = url.parse(port);

    if (parsed.pathname && parsed.pathname !== '/') {
      fn = host;
      host = null;
      tcpOpts.path = parsed.pathname;
    } else {
      if (url.protocol === 'tcp6:') {
        tcpOpts.family = 6;
        tcpOpts.host = parsed.hostname || '::';
      } else {
        tcpOpts.host = parsed.hostname || '0.0.0.0';
      }
      tcpOpts.port = parseInt(parsed.port, 10);
    }
  } else {
    tcpOpts.family = 4;
    tcpOpts.host = host || '0.0.0.0';
    tcpOpts.port = port;
  }

  var max = self.get('retry max timeout');
  this.type = 'client';
  var sock;
  var tlsOpts = this.get('tls');

  var onConnect = function() {
    debug('%s connect', self.type);
    self.connected = true;
    self.addSocket(sock);
    self.retry = self.get('retry timeout');
    self.emit('connect', sock);
    fn && fn();
  };

  if (tlsOpts) {
    tlsOpts.host = tcpOpts.host;
    tlsOpts.port = tcpOpts.port;
    debug('%s connect attempt %s:%s', self.type, host, port);
    sock = tls.connect(tlsOpts);
    sock.on('secureConnect', onConnect);
  } else {
    sock = new net.Socket();
    debug('%s connect attempt %s:%s', self.type, host, port);
    sock.connect(tcpOpts);
    sock.on('connect', onConnect);
  }

  sock.setNoDelay();

  this.handleErrors(sock);
  this.keepalive(sock);

  sock.on('close', function() {
    self.emit('socket close', sock);
    self.connected = false;
    self.removeSocket(sock);
    if (self.closing) return self.emit('close');
    var retry = self.retry || self.get('retry timeout');
    if (retry === 0) return self.emit('close');
    setTimeout(function(){
      debug('%s attempting reconnect', self.type);
      self.emit('reconnect attempt');
      sock.destroy();
      self.connect(port, host);
      self.retry = Math.round(Math.min(max, retry * 1.5));
    }, retry);
  });

  return this;
};

/**
 * Handle connection.
 *
 * @param {Socket} sock
 * @api private
 */

Socket.prototype.onconnect = function(sock){
  var self = this;
  var addr = null;

  if (sock.remoteAddress && sock.remotePort)
    addr = sock.remoteAddress + ':' + sock.remotePort;
  else if (sock.server && sock.server._pipeName)
    addr = sock.server._pipeName;

  var tlsOptions = self.get('tls');
  if (tlsOptions && !sock.authorized) {
    debug('%s denied %s for authorizationError %s', self.type, addr, sock.authorizationError);
  }
  debug('%s accept %s', self.type, addr);
  this.addSocket(sock);
  this.handleErrors(sock);
  this.keepalive(sock);
  this.emit('connect', sock);
  sock.on('close', function() {
    debug('%s disconnect %s', self.type, addr);
    self.emit('disconnect', sock);
    self.removeSocket(sock);
  });
};

/**
 * Bind to `port` at `host` and invoke `fn()`.
 *
 * Defaults `host` to INADDR_ANY.
 *
 * Emits:
 *
 *  - `connection` when a client connects
 *  - `disconnect` when a client disconnects
 *  - `bind` when bound and listening
 *
 * @param {Number|String} port
 * @param {Function} fn
 * @return {Socket}
 * @api public
 */

Socket.prototype.bind = function(port, host, fn){
  var self = this;
  if ('client' == this.type) throw new Error('cannot bind() after connect()');
  if ('function' == typeof host) {
    fn = host;
    host = undefined;
  }

  var unixSocket = false;

  if ('string' == typeof port) {
    port = url.parse(port);

    if (port.pathname && port.pathname !== '/') {
      fn = host;
      host = null;
      port = port.pathname;
      unixSocket = true;
    } else {
      host = port.hostname || '0.0.0.0';
      port = parseInt(port.port, 10);
    }
  } else {
    host = host || '0.0.0.0';
  }

  this.type = 'server';

  var tlsOptions = this.get('tls');
  if (tlsOptions) {
    tlsOptions.requestCert = tlsOptions.requestCert !== false;
    tlsOptions.rejectUnauthorized = tlsOptions.rejectUnauthorized !== false;
    this.server = tls.createServer(tlsOptions, this.onconnect.bind(this));
  } else {
    this.server = net.createServer(this.onconnect.bind(this));
  }

  debug('%s bind %s:%s', this.type, host, port);
  this.server.on('listening', this.emit.bind(this, 'bind'));

  if (unixSocket) {
    // TODO: move out
    this.server.on('error', function(e) {
      debug('Got error while trying to bind', e.stack || e);
      if (e.code == 'EADDRINUSE') {
        // Unix file socket and error EADDRINUSE is the case if
        // the file socket exists. We check if other processes
        // listen on file socket, otherwise it is a stale socket
        // that we could reopen
        // We try to connect to socket via plain network socket
        var clientSocket = new net.Socket();

        clientSocket.on('error', function(e2) {
          debug('Got sub-error', e2);
          if (e2.code == 'ECONNREFUSED' || e2.code == 'ENOENT') {
            // No other server listening, so we can delete stale
            // socket file and reopen server socket
            try {
              fs.unlinkSync(port);
            } catch(e) {}
            self.server.listen(port, host, fn);
          }
        });

        clientSocket.connect({path: port}, function() {
          // Connection is possible, so other server is listening
          // on this file socket
          if (fn) return fn(new Error('Process already listening on socket ' + port));
        });
      }
      else {
        try {
          fs.unlinkSync(port);
        } catch(e) {}
        self.server.listen(port, host, fn);
      }
    });
  }

  this.server.listen(port, host, fn);
  return this;
};
