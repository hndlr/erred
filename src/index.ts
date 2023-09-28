import * as _ from 'statuses'
import * as errors from '@hndlr/errors'
import type { Request, Response, NextFunction } from 'express'

/**
 * Module variables.
 * @private
 */

const objectRegExp = /^\[object (\S+)\]$/
const toString = Object.prototype.toString

exports = module.exports = createMiddleware

/**
 * Check if in production
 * @return {boolean}
 * @private
 * */
function isProduction (): boolean {
  return process.env.NODE_ENV === 'production'
}

export type Plugin = ((this: { errors: typeof errors }, err: Error) => errors.HTTPError | undefined)

/**
 * Workaround for now
 *
 * Since if the user passes a HTTPError from an
 * express middleware that should be parsed first
 * as we don't need to convert it to another object
 *
 * @private
 * */
const defaultPlugin: Plugin = (err: Error): errors.HTTPError | undefined => {
  if (err instanceof errors.HTTPError) return err
}

export interface ErredOptions {

  stack: boolean

  default500: boolean

  formatter: Formatter
}

/**
 * @param {Object} options
 * @param {boolean} options.stack - Show the error stack in the JSON object
 * @param {boolean} options.default500 - Convert a default error to a 500
 * */
export default function createMiddleware (options: Partial<ErredOptions>) {
  options = Object.assign({ stack: !isProduction(), default500: false, formatter: format }, options)

  /**
   * Express middleware
   *
   * @param {Error} err
   * @param {module:http.ClientRequest} req
   * @param {module:http.IncomingMessage} res
   * @param {Function} next
   * */
  const erred = function (err: Error, req: Request, res: Response, next: NextFunction) {
    erred.handleError(err, req, res, next)
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
   * @param {Plugin} fn
   * */
  erred.use = function use (fn: Plugin) {
    if (!fn) {
      throw new TypeError('erred.use() requires a middleware function')
    } else if (typeof fn !== 'function') {
      throw new TypeError('erred.use() requires a middleware function but got a ' + gettype(fn))
    }

    this.stack.push(fn)
  }

  erred.handleError = function handle (err: Error, req: Request, res: Response, next: NextFunction) {
    const self = this

    // middleware and routes
    let idx = 0
    const stack = self.stack

    let layer: Plugin
    let error: errors.HTTPError | undefined
    let match = false

    /**
     * Maybe overkill, but we should iterate through the
     * stack of middleware matching only if we get a HTTPError
     *
     * We exit on the first match
     * */
    while (match !== true && idx < stack.length) {
      layer = stack[idx++]
      error = layer.call({ errors }, err)

      if (error && error instanceof errors.HTTPError) {
        match = true
      }
    }

    /**
     * Pass this back to the express middleware
     * */
    if (!match && !options.default500) {
      return next(err)
    }

    if (options.default500) {
      error = new errors.InternalServerError(err.message, [err])
    }

    if (isEmpty(error!)) {
      return res.status(error.status).end()
    }

    if (isRedirect(error!)) {
      return res.status((error as errors.Redirect).status).redirect((error as errors.Redirect).redirectURL.toString())
    }

    let errorObject: Record<string, any>

    try {
      /**
       * Break the error down
       * */
      errorObject = (options.formatter || format)(error!, 0)
    } catch (err) {
      // If we have our own error best to throw back a 500
      error = new errors.InternalServerError('Failed to parse an error object', [err as Error])
      errorObject = (options.formatter || format)(error, 0)
    }
    if (options.stack) errorObject.stack = err.stack

    /**
     * Pass back to the user
     * */
    return res.status(error!.status).json({
      error: errorObject,
      meta: {
        status: error!.status,
      }
    })
  }

  return erred
}

export interface DefaultErrorObject {
  message: string

  name: string

  code?: string | number

  stack?: string

  errors?: DefaultErrorObject[]

  meta?: Record<string, any>
}

export type Formatter<ErrorObject extends Record<string, any> = DefaultErrorObject> =
  | ((error: errors.HTTPError | errors.UnderlyingError | errors.UnderlyingError[]) => ErrorObject | ErrorObject[])
  | ((error: errors.HTTPError | errors.UnderlyingError | errors.UnderlyingError[], depth: number) => ErrorObject | ErrorObject[])

function format(error: errors.HTTPError | errors.UnderlyingError | errors.UnderlyingError[], depth: number = 0): DefaultErrorObject | DefaultErrorObject[] {
  if (depth > 10) {
    throw new RangeError('Unable to process a depth greater than 10')
  }

  if (Array.isArray(error)) {
    return error.map((el) => format(el, depth)).filter(el => !Array.isArray(el)) as DefaultErrorObject[]
  }

  const errorObject: DefaultErrorObject = {
    message: error.message,
    name: error.name
  }

  if ('code' in error) {
    errorObject.code = error.code
  }

  if ('underlyingError' in error) {
    // Todo: Add a type that covers these, and add the placeholder of error
    errorObject.errors = format((error as errors.InternalServerError<Error>).underlyingError!, depth+1) as DefaultErrorObject[]
  }

  if ('meta' in error) {
    errorObject.meta = error.meta as Record<string, any>
  }

  if (('property' in error) || ('value' in error)) {
    errorObject.meta = {
      property: (error as errors.UnprocessableEntityError).property,
      value: (error as errors.UnprocessableEntityError).value
    }
  }

  return errorObject
}

// get type for error message
function gettype (obj: unknown) {
  const type = typeof obj

  if (type !== 'object') {
    return type
  }

  // inspect [[Class]] for objects
  return toString.call(obj)
    .replace(objectRegExp, '$1')
}

function isEmpty (error: errors.HTTPError): error is errors.EmptyContent {
  return (_.empty[error.status]) === true
}

function isRedirect (error: errors.HTTPError): error is errors.Redirect {
  return (_.redirect[error.status]) === true
}
