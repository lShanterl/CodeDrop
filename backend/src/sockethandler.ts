import type { WebSocket } from '@fastify/websocket';
import { randomUUID } from 'crypto';
import { FastifyInstance } from 'fastify';
import type { WebsocketHandler } from '@fastify/websocket';

type CustomWebSocket = WebSocket & {
  id?: string;
};

type SignalMessage =
  | { type: 'create-room' }
  | { type: 'join-room'; code: string }
  | { type: 'signal'; code: string; data: unknown; targetId?: string }; 
  

type Room = {
  hostId: string;
  guestIds: Set<string>;
};

const activeRooms = new Map<string, Room>();                  // code -> room
const connectedClients = new Map<string, CustomWebSocket>(); // id -> socket

export async function handleSocketConnections(fastify: FastifyInstance) {
  const socketHandler: WebsocketHandler = (connection, req) => {
    const rawSocket = connection;
    
    if (!rawSocket) {
      return;
    }

    const client = rawSocket as CustomWebSocket;    const id = randomUUID();
    client.id = id;
    connectedClients.set(id, client);

    fastify.log.info(`New client connected: ${id}`);


    client.on('message', (message: Buffer) => {
        try {
            const parsedMessage = JSON.parse(message.toString()) as SignalMessage;

            // CASE 1: create a new room
            if (parsedMessage.type === 'create-room') {
              const roomCode = Math.random().toString(36).substring(2, 8).toUpperCase();
              activeRooms.set(roomCode, { hostId: id, guestIds: new Set() });
              client.send(JSON.stringify({ type: 'room-created', code: roomCode }));
              return;
            }
            
            // CASE 2: join an existing room
            if (parsedMessage.type === 'join-room') {
              const { code } = parsedMessage;
              const room = activeRooms.get(code);
              const hostSocket = room ? connectedClients.get(room.hostId) : null;
            
              if (room && hostSocket) {
                room.guestIds.add(id);
            
                client.send(JSON.stringify({ type: 'joined-room', success: true, hostId: room.hostId }));
                hostSocket.send(JSON.stringify({ type: 'guest-joined', guestId: id }));
              } else {
                client.send(JSON.stringify({ type: 'joined-room', success: false, reason: 'not-found' }));
              }
              return;
            }

            // CASE 3: relay signaling data
            if (parsedMessage.type === 'signal') {
              const { code, data, targetId } = parsedMessage;
              const room = activeRooms.get(code);
              if (!room) return;
            
              let target: CustomWebSocket | undefined;
            
              if (id === room.hostId) {
                // host -> guest
                const actualTargetId = targetId || Array.from(room.guestIds)[0];
                if (!actualTargetId) return;
                target = connectedClients.get(actualTargetId);
              } else {
                // guest -> host
                target = connectedClients.get(room.hostId);
              }
          
              target?.send(JSON.stringify({ type: 'signal', data, from: id }));
              return;
            }
        
        }
        catch (err) {
            fastify.log.error(err, 'Failed to parse message');
        }
            
    });
        
    client.on('close', () => {
      connectedClients.delete(id);

      for (const [code, room] of activeRooms.entries()) {
        if (room.hostId === id) {
          // host disconnected -> notify all guests, remove room
          for (const guestId of room.guestIds) {
            connectedClients.get(guestId)?.send(JSON.stringify({ type: 'peer-left', peerId: id }));
          }
          activeRooms.delete(code);
        } else if (room.guestIds.has(id)) {
          // guest disconnected -> notify host, remove guest from set
          room.guestIds.delete(id);
          connectedClients.get(room.hostId)?.send(JSON.stringify({ type: 'peer-left', peerId: id }));
        }
      }

      fastify.log.info(`Client ${id} disconnected, memory cleared.`);
    });
    };

  fastify.get('/ws', { websocket: true }, socketHandler);

}