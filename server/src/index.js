import { Hono } from 'hono'
import { registerApiRoutes } from './api.js'
import { registerAdminRoutes } from './admin.js'

const app = new Hono()
registerApiRoutes(app)
registerAdminRoutes(app)
app.get('/', (c) => c.text('genspark account server'))

export default app
