const routes = { get: [], post: [] };
globalThis.__routes = routes;
function express() { return { use() {}, get: (p, h) => routes.get.push([p, h]), post: (p, h) => routes.post.push([p, h]), listen() {} }; }
express.json = () => () => {}; express.static = () => () => {};
export default express;
