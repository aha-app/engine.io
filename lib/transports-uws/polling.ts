import { Transport } from "../transport";
import { createGzip, createDeflate } from "zlib";
import * as accepts from "accepts";
import debugModule from "debug";
import { HttpRequest, HttpResponse } from "uWebSockets.js";

const debug = debugModule("engine:polling");

const compressionMethods = {
  gzip: createGzip,
  deflate: createDeflate
};

export class Polling extends Transport {
  public maxHttpBufferSize: number;
  public httpCompression: any;

  private res: HttpResponse;
  private dataReq: HttpRequest;
  private dataRes: HttpResponse;
  private shouldClose: Function;

  private readonly closeTimeout: number;

  /**
   * HTTP polling constructor.
   *
   * @api public.
   */
  constructor(req) {
    super(req);

    this.closeTimeout = 30 * 1000;
  }

  /**
   * Transport name
   *
   * @api public
   */
  get name() {
    return "polling";
  }

  get supportsFraming() {
    return false;
  }

  /**
   * Overrides onRequest.
   *
   * @param req
   *
   * @api private
   */
  onRequest(req) {
    const res = req.res;

    if (req.getMethod() === "get") {
      this.onPollRequest(req, res);
    } else if (req.getMethod() === "post") {
      this.onDataRequest(req, res);
    } else {
      res.writeStatus("500 Internal Server Error");
      res.end();
    }
  }

  /**
   * The client sends a request awaiting for us to send data.
   *
   * @api private
   */
  onPollRequest(req, res) {
    if (this.req) {
      debug("request overlap");
      // assert: this.res, '.req and .res should be (un)set together'
      this.onError("overlap from client");
      res.writeStatus("500 Internal Server Error");
      res.end();
      return;
    }

    debug("setting request");

    this.req = req;
    this.res = res;

    const onClose = () => {
      this.writable = false;
      this.onError("poll connection closed prematurely");
    };

    const cleanup = () => {
      this.req = this.res = null;
    };

    req.cleanup = cleanup;
    res.onAborted(onClose);

    this.writable = true;
    this.emit("drain");

    // if we're still writable but had a pending close, trigger an empty send
    if (this.writable && this.shouldClose) {
      debug("triggering empty send to append close packet");
      this.send([{ type: "noop" }]);
    }
  }

  /**
   * The client sends a request with data.
   *
   * @api private
   */
  onDataRequest(req, res) {
    if (this.dataReq) {
      // assert: this.dataRes, '.dataReq and .dataRes should be (un)set together'
      this.onError("data request overlap from client");
      res.writeStatus("500 Internal Server Error");
      res.end();
      return;
    }

    const expectedContentLength = Number(req.headers["content-length"]);

    if (!expectedContentLength) {
      this.onError("content-length header required");
      res.writeStatus("411 Length Required").end();
      return;
    }

    if (expectedContentLength > this.maxHttpBufferSize) {
      this.onError("payload too large");
      res.writeStatus("413 Payload Too Large").end();
      return;
    }

    const isBinary = "application/octet-stream" === req.headers["content-type"];

    if (isBinary && this.protocol === 4) {
      return this.onError("invalid content");
    }

    this.dataReq = req;
    this.dataRes = res;

    let buffer;
    let offset = 0;

    const headers = {
      // text/html is required instead of text/plain to avoid an
      // unwanted download dialog on certain user-agents (GH-43)
      "Content-Type": "text/html"
    };

    this.headers(req, headers);
    for (let key in headers) {
      res.writeHeader(key, String(headers[key]));
    }

    const onEnd = buffer => {
      this.onData(buffer.toString());
      this.onDataRequestCleanup();
      res.end("ok");
    };

    res.onAborted(() => {
      this.onDataRequestCleanup();
      this.onError("data request connection closed prematurely");
    });

    res.onData((arrayBuffer, isLast) => {
      const totalLength = offset + arrayBuffer.byteLength;
      if (totalLength > expectedContentLength) {
        this.onError("content-length mismatch");
        res.close(); // calls onAborted
        return;
      }

      if (!buffer) {
        if (isLast) {
          onEnd(Buffer.from(arrayBuffer));
          return;
        }
        buffer = Buffer.allocUnsafe(expectedContentLength);
      }

      Buffer.from(arrayBuffer).copy(buffer, offset);

      if (isLast) {
        if (totalLength != expectedContentLength) {
          this.onError("content-length mismatch");
          res.writeStatus("400 Content-Length Mismatch").end();
          this.onDataRequestCleanup();
          return;
        }
        onEnd(buffer);
        return;
      }

      offset = totalLength;
    });
  }

  /**
   * Cleanup request.
   *
   * @api private
   */
  private onDataRequestCleanup() {
    this.dataReq = this.dataRes = null;
  }

  /**
   * Processes the incoming data payload.
   *
   * @param {String} encoded payload
   * @api private
   */
  onData(data) {
    debug('received "%s"', data);
    const callback = packet => {
      if ("close" === packet.type) {
        debug("got xhr close packet");
        this.onClose();
        return false;
      }

      this.onPacket(packet);
    };

    if (this.protocol === 3) {
      this.parser.decodePayload(data, callback);
    } else {
      this.parser.decodePayload(data).forEach(callback);
    }
  }

  /**
   * Overrides onClose.
   *
   * @api private
   */
  onClose() {
    if (this.writable) {
      // close pending poll request
      this.send([{ type: "noop" }]);
    }
    super.onClose();
  }

  /**
   * Writes a packet payload.
   *
   * @param {Object} packet
   * @api private
   */
  send(packets) {
    this.writable = false;

    if (this.shouldClose) {
      debug("appending close packet to payload");
      packets.push({ type: "close" });
      this.shouldClose();
      this.shouldClose = null;
    }

    const doWrite = data => {
      const compress = packets.some(packet => {
        return packet.options && packet.options.compress;
      });
      this.write(data, { compress });
    };

    if (this.protocol === 3) {
      this.parser.encodePayload(packets, this.supportsBinary, doWrite);
    } else {
      this.parser.encodePayload(packets, doWrite);
    }
  }

  /**
   * Writes data as response to poll request.
   *
   * @param {String} data
   * @param {Object} options
   * @api private
   */
  write(data, options) {
    debug('writing "%s"', data);
    this.doWrite(data, options, () => {
      this.req.cleanup();
    });
  }

  /**
   * Performs the write.
   *
   * @api private
   */
  doWrite(data, options, callback) {
    // explicit UTF-8 is required for pages not served under utf
    const isString = typeof data === "string";
    const contentType = isString
      ? "text/plain; charset=UTF-8"
      : "application/octet-stream";

    const headers = {
      "Content-Type": contentType
    };

    const respond = data => {
      this.headers(this.req, headers);
      Object.keys(headers).forEach(key => {
        this.res.writeHeader(key, String(headers[key]));
      });
      this.res.end(data);
      callback();
    };

    if (!this.httpCompression || !options.compress) {
      respond(data);
      return;
    }

    const len = isString ? Buffer.byteLength(data) : data.length;
    if (len < this.httpCompression.threshold) {
      respond(data);
      return;
    }

    const encoding = accepts(this.req).encodings(["gzip", "deflate"]);
    if (!encoding) {
      respond(data);
      return;
    }

    this.compress(data, encoding, (err, data) => {
      if (err) {
        this.res.writeStatus("500 Internal Server Error");
        this.res.end();
        callback(err);
        return;
      }

      headers["Content-Encoding"] = encoding;
      respond(data);
    });
  }

  /**
   * Compresses data.
   *
   * @api private
   */
  compress(data, encoding, callback) {
    debug("compressing");

    const buffers = [];
    let nread = 0;

    compressionMethods[encoding](this.httpCompression)
      .on("error", callback)
      .on("data", function(chunk) {
        buffers.push(chunk);
        nread += chunk.length;
      })
      .on("end", function() {
        callback(null, Buffer.concat(buffers, nread));
      })
      .end(data);
  }

  /**
   * Closes the transport.
   *
   * @api private
   */
  doClose(fn) {
    debug("closing");

    let closeTimeoutTimer;

    const onClose = () => {
      clearTimeout(closeTimeoutTimer);
      fn();
      this.onClose();
    };

    if (this.writable) {
      debug("transport writable - closing right away");
      this.send([{ type: "close" }]);
      onClose();
    } else if (this.discarded) {
      debug("transport discarded - closing right away");
      onClose();
    } else {
      debug("transport not writable - buffering orderly close");
      this.shouldClose = onClose;
      closeTimeoutTimer = setTimeout(onClose, this.closeTimeout);
    }
  }

  /**
   * Returns headers for a response.
   *
   * @param req - request
   * @param {Object} extra headers
   * @api private
   */
  headers(req, headers) {
    headers = headers || {};

    // prevent XSS warnings on IE
    // https://github.com/LearnBoost/socket.io/pull/1333
    const ua = req.headers["user-agent"];
    if (ua && (~ua.indexOf(";MSIE") || ~ua.indexOf("Trident/"))) {
      headers["X-XSS-Protection"] = "0";
    }

    this.emit("headers", headers, req);
    return headers;
  }
}
