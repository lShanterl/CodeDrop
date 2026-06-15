CodeDrop is a decentralized, real-time, multi-peer file broadcasting network built using WebRTC Data Channels and WebSockets. It features a full-screen dashboard layout with an integrated monitoring terminal. CodeDrop allows a single host to broadcast an in-memory catalog of files to multiple concurrent guests, who can independently choose to download individual files or fetch the entire catalog seamlessly.

Link
https://code-drop-beta.vercel.app/

Deployment
Frontend: Hosted on Vercel - Live Application

Backend Signaling Server: Hosted on Render.com

Key Features
Multi-Peer Architecture: Supports an asymmetrical star topology where multiple guests connect to a single host simultaneously using standard WebRTC routing over WebSockets.

Dynamic Multi-File Catalog: The host manages a hot-swappable file registry. Any files added or removed instantly update the catalogs across all active peers in real-time.

Isolated Binary Streaming: Implements a strict separation of planes. Metadata travels through a persistent control channel, while file contents are transmitted through dynamically generated, independent data channels to eliminate buffer collisions.

Backpressure Management: Monitors data channel bufferedAmount against bufferedAmountLowThreshold to safely choke and resume file streams, preventing browser crashes on large assets.

Tech Stack
Frontend: Next.js, React, Tailwind CSS

Backend/Signaling: Fastify, @fastify/websocket, TypeScript

Networking APIs: WebRTC Core (RTCPeerConnection, RTCDataChannel), WebSocket API
