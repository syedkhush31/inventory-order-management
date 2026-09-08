function notFound(req, res) {
  return res.status(404).json({ error: 'Route not found' });
}

function global(error, req, res, next) {
  console.log(error);

  return res.status(500).json({ error: 'Internal server error' });
}

module.exports = { notFound, global };
