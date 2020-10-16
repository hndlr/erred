var fs = require('fs')
var assert = require('assert')

var express = require('express')
var request = require('supertest')
var { InternalServerError, NoContent, PermanentRedirect, UnprocessableEntity } = require('@hndlr/errors')

var erred = require('../src')

describe('erred()', function () {
  describe('.handle()', function () {
    it('should return an error without middleware', function (done) {
      var app = createServer((req, res, next) => {
        return next(new InternalServerError('This is a test'))
      })

      app.use(erred({ stack: false }))

      request(app).get('/')
        .expect(messageShouldBe('This is a test'))
        .expect(500, done)
    })

    it('should return stack if not in production', function (done) {
      var app = createServer((req, res, next) => {
        return next(new InternalServerError('This is a test'))
      })

      app.use(erred())

      request(app).get('/')
        .expect(messageShouldBe('This is a test'))
        .expect((res) => assert.ok(!res.body.error.stack))
        .expect(500, done)
    })

    it('should return stack if in production', function (done) {
      var app = createServer((req, res, next) => {
        return next(new InternalServerError('This is a test'))
      })

      process.env.NODE_ENV = 'production'
      app.use(erred())

      request(app).get('/')
        .expect(messageShouldBe('This is a test'))
        .expect((res) => assert.ok(!!res.body.error.stack))
        .expect(500, () => {
          // Clean up
          process.env.NODE_ENV = undefined
          done()
        })
    })

    it('should fallthrough if not returning a HTTPError subclass', function (done) {
      var app = createServer((req, res, next) => {
        return next(new Error('This is a test'))
      })

      app.use(erred({ stack: false }))

      app.use(function (err, req, res, next) {
        res.status(err.status || 500)
        res.send(err.message)
      })

      request(app).get('/')
        .expect((res) => assert.strictEqual(res.text, 'This is a test'))
        .expect(500, done)
    })

    it('should return a 204 on empty error', function (done) {
      var app = createServer((req, res, next) => {
        return next(new NoContent())
      })

      app.use(erred({ stack: false }))

      request(app).get('/').expect(204, done)
    })

    it('should redirect', function (done) {
      var app = createServer((req, res, next) => {
        return next(new PermanentRedirect('http://google.com'))
      })

      app.use(erred({ stack: false }))

      request(app)
        .get('/')
        .expect('location', 'http://google.com')
        .expect(302, done)
    })
  })

  describe('.use()', function () {
    it('should throw an error on invalid fn', function () {
      const errorHandler = erred()
      assert.throws(() => errorHandler.use([]))
    })

    it('should throw an error on null fn', function () {
      const errorHandler = erred()
      assert.throws(() => errorHandler.use())
    })

    // This is for a coverage
    it('should throw an error on number fn', function () {
      const errorHandler = erred()
      assert.throws(() => errorHandler.use(2))
    })

    it('should return underlyingError with meta data', function (done) {
      var app = createServer((req, res, next) => {
        try {
          fs.readFileSync('./we/need/an/error.thanks')
        } catch (error) {
          return next(error)
        }
      })

      const errorHandler = erred()

      let errno, path
      errorHandler.use((err) => {
        if (err.code === 'ENOENT') {
          const _error = new Error(err.message)
          _error.code = _error.name = err.code
          _error.stack = err.stack
          _error.meta = {
            path: err.path,
            errno: err.errno
          }

          errno = err.errno; path = err.path

          return new InternalServerError('Process failed', _error)
        }
      })

      app.use(errorHandler)

      request(app).get('/')
        .expect(messageShouldBe('Process failed'))
        .expect((res) => assert.strictEqual(res.body.error.underlyingError.meta.path, path))
        .expect((res) => assert.strictEqual(res.body.error.underlyingError.meta.errno, errno))
        .expect(500, done)
    })

    it('should overwrite the stack with underlyingError', function (done) {
      var app = createServer((req, res, next) => {
        try {
          fs.readFileSync('./we/need/an/error.thanks')
        } catch (error) {
          return next(error)
        }
      })

      const errorHandler = erred({ stack: true })

      let errno, path, stack
      errorHandler.use((err) => {
        if (err.code === 'ENOENT') {
          const _error = new Error(err.message)
          _error.code = _error.name = err.code
          stack = _error.stack = err.stack
          _error.meta = {
            path: err.path,
            errno: err.errno
          }

          errno = err.errno; path = err.path

          return new InternalServerError('Process failed', _error)
        }
      })

      app.use(errorHandler)

      request(app).get('/')
        .expect(messageShouldBe('Process failed'))
        .expect((res) => assert.strictEqual(res.body.error.stack, stack))
        .expect(500, done)
    })

    it('should return an array of underlyingErrors', function (done) {
      var app = createServer((req, res, next) => {
        const error = new Error('Failed validation')
        error.name = 'ValidationError'
        error.errors = [
          new Error('Failed creation'),
          new Error('Failed something else')
        ]
        return next(error)
      })

      const errorHandler = erred()

      errorHandler.use((err) => {
        if (err.name === 'ValidationError') {
          const underlyingError = err.errors.map((error) => {
            const _error = new Error(error.message)
            error.name = 'MongoValidationError'
            error.meta = {
              yes: true
            }
            return _error
          })
          return new UnprocessableEntity('The request could not be completed due to an invalid body', underlyingError)
        }
      })

      app.use(errorHandler)

      request(app).get('/')
        .expect(messageShouldBe('The request could not be completed due to an invalid body'))
        .expect((res) => assert.strictEqual(res.body.error.underlyingError.length, 2))
        .expect(422, done)
    })
  })
})

function createServer (fn) {
  const app = express()
  app.use(fn)
  return app
}

function messageShouldBe (message) {
  return function (res) {
    assert.strictEqual(message, res.body.error.message, 'should not have message ' + message)
  }
}
