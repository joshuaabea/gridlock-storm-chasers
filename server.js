import { createGameServer } from './server/app.js';

const server = createGameServer({ publicOrigin: process.env.PUBLIC_ORIGIN });
const port = Number(process.env.PORT || 3000);
await server.listen(port, '0.0.0.0');
console.log(`Gridlock: Storm Chasers listening on port ${port}`);
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => {
  await server.close();
  process.exit(0);
});
