## @hndlr/erred

### Usage

Slot this code with express to handle errors and turn them into readable JSON objects

```javascript
const express = require('express')
const { NotFound } = require('@hndlr/errors')

const app = express()
const port = 3000

app.get('*', (req, res, next) => {
  return next(new NotFound(`Could not find ${req.url}`))
})

app.use(require('@hndlr/erred')())

app.listen(port, () => {
  console.log(`Example app listening at http://localhost:${port}`)
})
```
