const _ = require('statuses')
const errors = require('@hndlr/errors')

/**
 * @callback MiddlewareCallback
 *
 * @param {Error} err
 * @return {Error|null}
 * */

/**
 * Module variables.
 * @private
 */

var objectRegExp = /^\[object (\S+)\]$/
var toString = Object.prototype.toString;

/**
 * Check if in production
 * @return {boolean}
 * @private
 * */
function isProduction () {
  return process.env.NODE_ENV === 'production'
}

/**
 * Workaround for now
 *
 * Since if the user passes a HTTPError from an
 * express middleware that should be parsed first
 * as we don't need to convert it to another object
 *
 * @private
 * */
const defaultPlugin = (err) => {
  if (err instanceof errors.HTTPError) return err
}

/**
 * Set the stack for the error
 *
 * If there is a singular underlying error that stack
 * should be set?? Maybe?? Look into this
 *
 * Why the underlying error, if it's something like an
 * 'Internal Server Error' the underlying error is
 * important
 *
 * @param {Error} error
 * @param {Error} error.underlyingError
 * @param {Object} errorObject
 * @private
 * */
const setErrorStack = (error, errorObject) => {
  if (!!errorObject.underlyingError && !Array.isArray(errorObject.underlyingError)) {
    errorObject.stack = error.underlyingError.stack
    return
  }

  errorObject.stack = error.stack
}

exports = module.exports = createMiddleware

/**
 * @param {Object} options
 * @param {boolean} options.stack - Show the error stack in the JSON object
 * */
function createMiddleware (options = { stack: isProduction() }) {
  /**
   * Express middleware
   *
   * @param {Error} err
   * @param {module:http.ClientRequest} req
   * @param {module:http.IncomingMessage} res
   * @param {Function} next
   * */
  const erred = function (err, req, res, next) {
    erred.handleError(...arguments)
  }

  /**
   * @private
   * */
  erred.stack = [defaultPlugin]

  /**
   * Erred is built to be minimal. Not even creating the errors
   * itself. Essentially you create the middleware for each layer you
   * have
   *
   * ```javascript
   * erred.use(function (err) {
   *   if (err.name === 'MongoError' && err.code === 11000) {
   *     return new this.errors.Conflict(...)
   *   }
   * })
   * ```
   * @param {MiddlewareCallback} fn
   * */
  erred.use = function use (fn) {
    if (!fn) {
      throw new TypeError('erred.use() requires a middleware function')
    }

    if (typeof fn !== 'function') {
      throw new TypeError('erred.use() requires a middleware function but got a ' + gettype(fn))
    }

    this.stack.push(fn)
  }

  /**
   * Handle the error with its middleware
   * @private
   * */
  erred.handleError = function handle (err, req, res, next) {
    var self = this

    // middleware and routes
    var idx = 0
    var stack = self.stack

    var layer
    var error
    var match

    /**
     * Maybe overkill but we should iterate through the
     * stack of middleware matching only if we get a HTTPError
     * */
    while (match !== true && idx < stack.length) {
      layer = stack[idx++]
      error = layer(err)

      if (error && error instanceof errors.HTTPError) {
        match = true
      }
    }

    /**
     * Pass this back to the express middleware
     * */
    if (match !== true) {
      return next(err)
    }

    if (_.empty[error.status]) {
      return res.status(error.status).end()
    }

    if (_.redirect[error.status]) {
      return res.status(error.status).redirect(error.redirectURL)
    }

    /**
     * Break the error down
     * */
    const errorObject = breakdownErrorToObject(error)
    if (options.stack) setErrorStack(error, errorObject)

    /**
     * Pass back to the user
     * */
    return res.status(error.status).json({
      status: error.status,
      error: errorObject
    })
  }

  return erred
}

/**
 * Turn the error's into the JSON object
 *
 * @param {number} depth -
 * @param {Error|Error[]} error -
 * @param {Error|Error[]} error.underlyingError -
 * @param {Object} error.meta -
 * */
function breakdownErrorToObject (error, depth = 0) {
  if (Array.isArray(error)) {
    return error.map((el) => breakdownErrorToObject(el, depth))
  }

  const errorObject = {
    message: error.message,
    name: error.name,
    code: error.code
  }

  if (error.underlyingError) errorObject.underlyingError = breakdownErrorToObject(error.underlyingError, depth += 1)

  return {
    ...errorObject,
    meta: error.meta
  }
}

// get type for error message
function gettype (obj) {
  const type = typeof obj;

  if (type !== 'object') {
    return type
  }

  // inspect [[Class]] for objects
  return toString.call(obj)
    .replace(objectRegExp, '$1')
}
