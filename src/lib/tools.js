const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

function isJsonString(str) {
  try {
    JSON.parse(str)
    return true
  } catch (e) {
    return false
  }
}


module.exports = {
  sleep,
  isJsonString
}