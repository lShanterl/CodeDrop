import fastify from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import { handleSocketConnections } from './sockethandler.js';

async function main() {
	const app = fastify({ logger: true });

	await app.register(cors);

	await handleSocketConnections(app);

	const port = Number(process.env.PORT ?? 3000);
	await app.listen({ port, host: '0.0.0.0' });

	
}

void main().catch((error: unknown) => {
	process.exitCode = 1;
	console.error(error);
});
