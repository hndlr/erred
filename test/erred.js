var fs = require('fs')
var assert = require('assert')

var express = require('express')
var request = require('supertest')
var { InternalServerError, NoContent, PermanentRedirect, UnprocessableEntity } = require('@hndlr/errors')

var erred = require('../dist')

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
        .expect((res) => assert.ok(res.body.error.stack))
        .expect(500, done)
    })

    it('should not return stack if in production', function (done) {
      var app = createServer((req, res, next) => {
        return next(new InternalServerError('This is a test'))
      })

      process.env.NODE_ENV = 'production'
      app.use(erred())

      request(app).get('/')
        .expect(messageShouldBe('This is a test'))
        .expect((res) => assert.ok(!res.body.error.stack))
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

    it('should not fallthrough if using `default500`', function (done) {
      var app = createServer((req, res, next) => {
        return next(new Error('This is a test'))
      })

      app.use(erred({ stack: false, default500: true }))

      request(app).get('/')
        .expect(messageShouldBe('This is a test'))
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

    it('should format 422 correctly', function (done) {
      var app = createServer((req, res, next) => {
        return next(new UnprocessableEntity('Unable to update', [
          Object.assign(new Error('name should be a string'), { property: 'name', value: 1337 })
        ]))
      })

      app.use(erred({ stack: false }))

      request(app)
        .get('/')
        .expect((res) => assert.deepStrictEqual(res.body.error.errors[0].meta, { property: 'name', value: 1337 }))
        .expect((res) => assert.strictEqual(res.body.error.errors.length, 1))
        .expect(422, done)
    });

    it('should throw when the underlying errors hit a max depth', function (done) {
      var app = createServer((req, res, next) => {
        return next(new UnprocessableEntity('Unable to update', [
          createUnderlyingErrorWithDepth(11)
        ]))
      })

      app.use(erred({ stack: false }))

      request(app).get('/')
        .expect(messageShouldBe('Failed to parse an error object'))
        .expect(500, done)
    });
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

          return new InternalServerError('Process failed', [_error])
        }
      })

      app.use(errorHandler)

      request(app).get('/')
        .expect(messageShouldBe('Process failed'))
        .expect((res) => assert.strictEqual(res.body.error.errors[0].meta.path, path))
        .expect((res) => assert.strictEqual(res.body.error.errors[0].meta.errno, errno))
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
        .expect((res) => assert.strictEqual(res.body.error.errors.length, 2))
        .expect(422, done)
    })
  })

  describe('formatter', function () {
    it('should allow for a custom formatter to be passed', function (done) {
      const errorMap = {
        71818: {
          message: 'Unable to process an order due to incorrect input',
          documentationURL: 'https://docs.example.com/REST/order#postOrder'
        }
      }

      function documentationFormat(error, depth = 0) {
        if (depth > 10) {
          throw new RangeError('Unable to process a depth greater than 10');
        }

        if (Array.isArray(error)) {
          return error.map((el) => documentationFormat(el, depth)).filter(el => !Array.isArray(el));
        }

        const errorObject = {
          message: error.message,
          name: error.name
        };

        if ('code' in error) {
          errorObject.code = error.code;
        }

        if (errorMap[errorObject.code]) {
          errorObject.message = errorMap[errorObject.code].message
          errorObject.documentationURL = errorMap[errorObject.code].documentationURL
        }

        if ('underlyingError' in error) {
          errorObject.errors = documentationFormat(error.underlyingError, depth + 1);
        }

        if ('meta' in error) {
          errorObject.meta = error.meta;
        }

        if (('property' in error) || ('value' in error)) {
          errorObject.meta = {
            property: error.property,
            value: error.value
          };
        }
        return errorObject;
      }

      var app = createServer((req, res, next) => {
        return next(new UnprocessableEntity('Unable to create new order', [
          Object.assign(new Error('name should be a string'), { property: 'name', value: 1337 })
        ], 71818))
      })

      app.use(erred({ stack: false, formatter: documentationFormat }))

      request(app)
        .get('/')
        .expect(messageShouldBe('Unable to process an order due to incorrect input'))
        .expect((res) => assert.strictEqual(res.body.error.documentationURL, 'https://docs.example.com/REST/order#postOrder'))
        .expect((res) => assert.deepStrictEqual(res.body.error.errors[0].meta, { property: 'name', value: 1337 }))
        .expect((res) => assert.strictEqual(res.body.error.errors.length, 1))
        .expect(422, done)
    });
  })
})

function createServer (fn) {
  const app = express()
  app.use(fn)
  return app
}

function messageShouldBe (message) {
  return function (res) {
    console.assert(res.body)
    assert.strictEqual(message, res.body.error.message, 'should not have message ' + message)
  }
}

function createUnderlyingErrorWithDepth (depth = 10, ofObject) {
  var err;
  var prev;

  for (let i = 0; i < depth; i++) {
    var error = Object.assign(new Error(`depth=${i}`), { underlyingError: [] })

    if (!err)
      err = error

    if (prev)
      prev.underlyingError.push(error)

    prev = error
  }

  return err
}
