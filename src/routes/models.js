const express = require('express')
const router = express.Router()
const modelMap = require('../lib/model-map')

router.get('/v1/models', (req, res) => {

  const result = Object.keys(modelMap).map((id) => {
    const model_data = {
      id,
      object: "model",
      created: 1626777600,
      owned_by: modelMap[id].provider
    }
    if (modelMap[id].parameters) {
      for (const item in modelMap[id].parameters) {
        model_data[item] = modelMap[id].parameters[item]
      }
    }
    return model_data
  })

  res.json({
    object: "list",
    data: result
  })
})

module.exports = router