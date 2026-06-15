'use client';

import { useState, useRef } from 'react';

const CHUNK_SIZE = 16384;
const BUFFER_THRESHOLD = 65536; // 64 KB - must be set on the channel before sending

type PeerConnectionMap = Map<string, RTCPeerConnection>;
type DataChannelMap = Map<string, RTCDataChannel>;

interface FileData {
  id: string;
  name: string;
  size: number;
  file: File;
}

interface FileMetadata {
  id: string;
  name: string;
  size: number;
}

interface DownloadStatus {
  progress: number;
  name: string;
  status: 'downloading' | 'completed';
}

export default function Home() {
  const [roomCode, setRoomCode] = useState('');
  const [inputCode, setInputCode] = useState('');
  const [status, setStatus] = useState('Disconnected');
  const [transferLog, setTransferLog] = useState<string[]>([]);
  const [isHostRole, setIsHostRole] = useState<boolean | null>(null);
  const [hostFiles, setHostFiles] = useState<FileData[]>([]);
  const [availableFiles, setAvailableFiles] = useState<FileMetadata[]>([]);
  const [downloads, setDownloads] = useState<Record<string, DownloadStatus>>({});
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const socketRef = useRef<WebSocket | null>(null);
  const activeRoomCodeRef = useRef<string>('');
  const peersRef = useRef<PeerConnectionMap>(new Map());
  const controlChannelsRef = useRef<DataChannelMap>(new Map());
  const hostFilesRef = useRef<FileData[]>([]);
  const roleRef = useRef<'host' | 'guest' | null>(null);
  const keepAliveRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const addLog = (msg: string) => setTransferLog((prev) => [...prev, msg]);

  const broadcastFileList = (files: FileData[]) => {
    const metadata = files.map(f => ({ id: f.id, name: f.name, size: f.size }));
    controlChannelsRef.current.forEach(dc => {
      if (dc.readyState === 'open') {
        dc.send(JSON.stringify({ type: 'file-list', files: metadata }));
      }
    });
  };

  const handleFilesAdded = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files) return;
    const newFiles = Array.from(e.target.files).map(file => ({
      id: Math.random().toString(36).substring(2, 10),
      name: file.name,
      size: file.size,
      file
    }));

    const updated = [...hostFilesRef.current, ...newFiles];
    hostFilesRef.current = updated;
    setHostFiles(updated);
    broadcastFileList(updated);
  };

  const removeFile = (fileId: string) => {
    const updated = hostFilesRef.current.filter(f => f.id !== fileId);
    hostFilesRef.current = updated;
    setHostFiles(updated);
    broadcastFileList(updated);
    addLog(`Removed file from catalog`);
  };

  const createPeerConnection = (targetId: string, isHost: boolean) => {
    const peer = new RTCPeerConnection({
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        {
          urls: 'turn:openrelay.metered.ca:80',
          username: 'openrelayproject',
          credential: 'openrelayproject'
        },
        {
          urls: 'turn:openrelay.metered.ca:443',
          username: 'openrelayproject',
          credential: 'openrelayproject'
        },
        {
          urls: 'turn:openrelay.metered.ca:443?transport=tcp',
          username: 'openrelayproject',
          credential: 'openrelayproject'
        }
      ]
    });

    peersRef.current.set(targetId, peer);

    peer.onicecandidate = (event) => {
      if (event.candidate) {
        socketRef.current?.send(JSON.stringify({
          type: 'signal',
          code: activeRoomCodeRef.current,
          targetId: targetId,
          data: { candidate: event.candidate }
        }));
      }
    };

    if (isHost) {
      addLog(`Connecting to peer: ${targetId.substring(0, 6)}...`);
      const dc = peer.createDataChannel('control');
      setupControlChannel(dc, targetId, true);
    } else {
      peer.ondatachannel = (event) => {
        const channel = event.channel;
        if (channel.label === 'control') {
          addLog('Connected to host data channel');
          setupControlChannel(channel, targetId, false);
        } else {
          setupFileReceiverChannel(channel);
        }
      };
    }

    return peer;
  };

  const setupControlChannel = (dc: RTCDataChannel, targetId: string, isHost: boolean) => {
    controlChannelsRef.current.set(targetId, dc);

    dc.onopen = () => {
      setStatus('Connected directly to peer');
      if (isHost) {
        dc.send(JSON.stringify({
          type: 'file-list',
          files: hostFilesRef.current.map(f => ({ id: f.id, name: f.name, size: f.size }))
        }));
        addLog(`Sent file list to peer ${targetId.substring(0, 6)} (${hostFilesRef.current.length} file(s))`);
      }
    };

    dc.onclose = () => {
      addLog(`Connection closed with peer ${targetId.substring(0, 6)}`);
      peersRef.current.delete(targetId);
      controlChannelsRef.current.delete(targetId);
    };

    dc.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data as string);
        if (msg.type === 'file-list') {
          setAvailableFiles(msg.files);
          addLog(`Updated file list received: ${msg.files.length} item(s) available`);
        }
        if (msg.type === 'request-file' && isHost) {
          const requestedFile = hostFilesRef.current.find(f => f.id === msg.fileId);
          if (requestedFile) {
            startFileTransfer(targetId, requestedFile);
          }
        }
      } catch (e) {
        console.error('Error handling control channel message:', e);
      }
    };
  };

  const startFileTransfer = async (guestId: string, fileData: FileData) => {
    const peer = peersRef.current.get(guestId);
    if (!peer) return;

    const fileDc = peer.createDataChannel(`file_${fileData.id}_${Math.random().toString(36).substr(2, 5)}`);
    fileDc.binaryType = 'arraybuffer';
    fileDc.bufferedAmountLowThreshold = BUFFER_THRESHOLD;

    fileDc.onopen = async () => {
      addLog(`Sending file: ${fileData.name}`);
      fileDc.send(JSON.stringify({ type: 'file-start', id: fileData.id, name: fileData.name, size: fileData.size }));

      const reader = fileData.file.stream().getReader();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        let offset = 0;
        while (offset < value.length) {
          if (fileDc.bufferedAmount > fileDc.bufferedAmountLowThreshold) {
            await new Promise<void>((resolve) => {
              fileDc.onbufferedamountlow = () => {
                fileDc.onbufferedamountlow = null;
                resolve();
              };
            });
          }
          if (fileDc.readyState !== 'open') break;
          const chunk = value.slice(offset, offset + CHUNK_SIZE);
          fileDc.send(chunk.buffer);
          offset += CHUNK_SIZE;
        }
      }

      addLog(`Successfully sent: ${fileData.name}`);
      setTimeout(() => fileDc.close(), 1000);
    };
  };

  const setupFileReceiverChannel = (dc: RTCDataChannel) => {
    dc.binaryType = 'arraybuffer';

    let fileBuffer: Uint8Array[] = [];
    let currentSize = 0;
    let expectedSize = 0;
    let fileName = '';
    let fileId = '';

    dc.onmessage = (event) => {
      if (typeof event.data === 'string') {
        try {
          const meta = JSON.parse(event.data);
          if (meta.type === 'file-start') {
            fileId = meta.id;
            fileName = meta.name;
            expectedSize = meta.size;
            fileBuffer = [];
            currentSize = 0;
            setDownloads(prev => ({ ...prev, [fileId]: { progress: 0, name: fileName, status: 'downloading' } }));
            addLog(`Receiving file: ${fileName}`);
          }
        } catch (e) {
          console.error('Error parsing file metadata:', e);
        }
      } else if (event.data instanceof ArrayBuffer) {
        fileBuffer.push(new Uint8Array(event.data));
        currentSize += event.data.byteLength;

        const pct = Math.min(Math.round((currentSize / expectedSize) * 100), 100);

        setDownloads(prev => {
          if (prev[fileId]?.progress === pct) return prev;
          return { ...prev, [fileId]: { progress: pct, name: fileName, status: 'downloading' } };
        });

        if (currentSize >= expectedSize) {
          setDownloads(prev => ({ ...prev, [fileId]: { progress: 100, name: fileName, status: 'completed' } }));
          addLog(`Successfully downloaded: ${fileName}`);

          const fileBlob = new Blob(fileBuffer as BlobPart[], { type: 'application/octet-stream' });
          const downloadUrl = URL.createObjectURL(fileBlob);
          const a = document.createElement('a');
          a.href = downloadUrl;
          a.download = fileName;
          a.click();
          URL.revokeObjectURL(downloadUrl);
          fileBuffer = [];
        }
      }
    };
  };

  const requestDownload = (fileId: string) => {
    const dc = Array.from(controlChannelsRef.current.values())[0];
    if (dc && dc.readyState === 'open') {
      dc.send(JSON.stringify({ type: 'request-file', fileId }));
    }
  };

  const requestAllDownloads = () => availableFiles.forEach(f => requestDownload(f.id));

  const redownload = (fileId: string) => {
    setDownloads(prev => {
      const updated = { ...prev };
      delete updated[fileId];
      return updated;
    });
    setTimeout(() => requestDownload(fileId), 50);
  };

  const connectWebSocket = (role: 'host' | 'guest', onConnectedAction: (ws: WebSocket) => void) => {
    setIsHostRole(role === 'host');
    roleRef.current = role;

    if (socketRef.current && socketRef.current.readyState === WebSocket.OPEN) {
      onConnectedAction(socketRef.current);
      return;
    }

    const backendUrl = process.env.NEXT_PUBLIC_WS_URL || 'ws://localhost:3000/ws';
    const ws = new WebSocket(backendUrl);
    socketRef.current = ws;

    ws.onopen = () => {
      setStatus('Connected to server');
      onConnectedAction(ws);

      if (keepAliveRef.current) clearInterval(keepAliveRef.current);
        keepAliveRef.current = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'ping' }));
          }
        }, 25000);
      };

    ws.onclose = () => {
      setStatus('Disconnected');
      if (keepAliveRef.current) {
        clearInterval(keepAliveRef.current);
        keepAliveRef.current = null;
      }
    };

    ws.onmessage = async (event) => {
      const msg = JSON.parse(event.data as string);

      if (msg.type === 'room-created') {
        setRoomCode(msg.code);
        activeRoomCodeRef.current = msg.code;
        setStatus('Room Created');
      }

      if (msg.type === 'joined-room' && msg.success) setStatus('Joined room! Waiting for host...');

      if (msg.type === 'guest-joined') {
        setStatus('Peer connected');
        const guestId = msg.guestId;
        const peer = createPeerConnection(guestId, true);
        const offer = await peer.createOffer();
        await peer.setLocalDescription(offer);
        ws.send(JSON.stringify({ type: 'signal', code: activeRoomCodeRef.current, targetId: guestId, data: { offer } }));
      }

      if (msg.type === 'signal') {
        const senderId = msg.from;
        let peer = peersRef.current.get(senderId);

        if (!peer && roleRef.current === 'guest') peer = createPeerConnection(senderId, false);
        if (!peer) return;

        if (msg.data.offer) {
          await peer.setRemoteDescription(new RTCSessionDescription(msg.data.offer));
          const answer = await peer.createAnswer();
          await peer.setLocalDescription(answer);
          ws.send(JSON.stringify({ type: 'signal', code: activeRoomCodeRef.current, targetId: senderId, data: { answer } }));
        } else if (msg.data.answer) {
          await peer.setRemoteDescription(new RTCSessionDescription(msg.data.answer));
        } else if (msg.data.candidate) {
          await peer.addIceCandidate(new RTCIceCandidate(msg.data.candidate)).catch(() => {});
        }
      }
    };
  };

  return (
    <div className="flex flex-col md:flex-row h-screen w-full bg-slate-950 selection:bg-indigo-500/30 overflow-hidden text-slate-100 font-sans relative">

      <div className="md:hidden flex items-center justify-between bg-slate-900 border-b border-slate-800 px-5 py-4 z-30 shrink-0">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-bold text-transparent bg-clip-text bg-gradient-to-r from-blue-400 to-indigo-400 tracking-tight">
            CodeDrop
          </h1>
          <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-medium bg-slate-950 border ${status.includes('CONNECTED') || status.includes('peer') ? 'text-emerald-400 border-emerald-950' : 'text-blue-400 border-slate-800'}`}>
            <span className={`w-1.5 h-1.5 rounded-full ${status.includes('Disconnected') ? 'bg-slate-600' : 'bg-emerald-500 animate-pulse'}`}></span>
            Active
          </span>
        </div>
        <button
          onClick={() => setSidebarOpen(true)}
          className="p-2 text-slate-400 hover:text-slate-200 transition-colors rounded-lg bg-slate-950 border border-slate-800"
        >
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
          </svg>
        </button>
      </div>

      {sidebarOpen && (
        <div
          onClick={() => setSidebarOpen(false)}
          className="fixed inset-0 bg-black/60 backdrop-blur-sm z-40 md:hidden transition-opacity duration-300"
        />
      )}

      <aside className={`fixed inset-y-0 left-0 w-80 lg:w-96 bg-slate-900 border-r border-slate-800 flex flex-col z-50 shadow-2xl md:shadow-xl transform transition-transform duration-300 ease-in-out md:static md:translate-x-0 ${sidebarOpen ? 'translate-x-0' : '-translate-x-full'}`}>
        <div className="p-6 border-b border-slate-800 flex items-center justify-between">
          <div>
            <h1 className="text-2xl text-transparent bg-clip-text bg-gradient-to-r from-blue-400 to-indigo-400 font-bold tracking-tight mb-1">
              CodeDrop
            </h1>
            <p className="text-xs text-slate-400 font-medium tracking-wide">P2P File Sharing Network</p>
          </div>
          <button
            onClick={() => setSidebarOpen(false)}
            className="md:hidden p-2 text-slate-400 hover:text-slate-200 transition-colors"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="p-6 flex flex-col gap-6 flex-1 overflow-hidden">

          <div className="bg-slate-950 p-4 rounded-xl border border-slate-800">
            <h3 className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider mb-2">Connection Status</h3>
            <p className={`text-sm font-medium truncate ${status.includes('CONNECTED') || status.includes('peer') ? 'text-emerald-400' : 'text-blue-400'}`}>
              {status}
            </p>

            {roomCode && (
              <div className="mt-4 pt-4 border-t border-slate-800">
                <span className="text-[10px] uppercase font-semibold text-slate-400 tracking-wider block mb-2">Room Code</span>
                <div className="text-2xl font-bold text-slate-100 bg-slate-900 py-2 px-3 rounded-lg border border-slate-800 text-center select-all tracking-wider">
                  {roomCode}
                </div>
              </div>
            )}

            {isHostRole !== null && !roomCode && (
              <div className="mt-4 pt-4 border-t border-slate-800">
                <span className="text-[10px] uppercase font-semibold text-slate-400 tracking-wider block mb-2">Your Role</span>
                <span className="text-blue-400 text-xs font-semibold bg-blue-950/40 px-3 py-1 rounded-md border border-blue-900/50 inline-block tracking-wide">
                  {isHostRole ? 'Sender' : 'Receiver'}
                </span>
              </div>
            )}
          </div>

          {isHostRole === null && (
            <div className="flex flex-col gap-4">
              <button
                onClick={() => connectWebSocket('host', (ws) => ws.send(JSON.stringify({ type: 'create-room' })))}
                className="w-full py-2.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg font-medium transition-all text-sm active:scale-[0.98] shadow-md"
              >
                Create Share Room
              </button>

              <div className="relative flex items-center py-1">
                <div className="flex-grow border-t border-slate-800"></div>
                <span className="flex-shrink-0 mx-4 text-slate-500 text-[10px] font-bold tracking-wider">OR JOIN ROOM</span>
                <div className="flex-grow border-t border-slate-800"></div>
              </div>

              <div className="flex gap-2">
                <input
                  type="text"
                  placeholder="Enter Room Code"
                  value={inputCode}
                  onChange={(e) => setInputCode(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-800 text-slate-200 rounded-lg px-3 py-2 text-center uppercase tracking-wider font-semibold placeholder-slate-600 focus:outline-none focus:border-indigo-500 text-sm"
                />
                <button
                  onClick={() => {
                    if (!inputCode) return;
                    activeRoomCodeRef.current = inputCode.toUpperCase();
                    connectWebSocket('guest', (ws) => ws.send(JSON.stringify({ type: 'join-room', code: inputCode.toUpperCase() })));
                    setSidebarOpen(false);
                  }}
                  className="px-4 py-2 bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 rounded-lg font-medium transition-colors text-sm"
                >
                  Join
                </button>
              </div>
            </div>
          )}

          <div className="flex-1 flex flex-col min-h-[150px]">
            <h4 className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider mb-2 flex items-center gap-2">
              <span className={`w-2 h-2 rounded-full ${status.includes('Disconnected') ? 'bg-slate-600' : 'bg-emerald-500 animate-pulse'}`}></span>
              Activity Log
            </h4>
            <div className="bg-slate-950 text-slate-300 p-4 rounded-xl flex-1 overflow-y-auto text-xs font-mono border border-slate-800 shadow-inner scrollbar-thin scrollbar-thumb-slate-800 scrollbar-track-transparent">
              {transferLog.length === 0 ? (
                <p className="text-slate-600 italic">No activity recorded yet.</p>
              ) : (
                transferLog.map((log, idx) => (
                  <div key={idx} className="mb-1.5 flex gap-2 items-start text-slate-400">
                    <span className="text-slate-600 select-none">&middot;</span>
                    <span className="break-words font-sans">{log}</span>
                  </div>
                ))
              )}
            </div>
          </div>

        </div>
      </aside>

      <main className="flex-1 bg-gradient-to-tr from-slate-950 via-slate-900 to-slate-950 p-6 md:p-10 overflow-y-auto relative z-10 h-full">

        {isHostRole === null && (
          <div className="h-full flex flex-col items-center justify-center text-slate-600 select-none text-center max-w-sm mx-auto">
            <svg className="w-12 h-12 mb-4 text-indigo-500/50" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
            </svg>
            <h2 className="text-sm font-medium tracking-wide text-slate-400">Establish a Connection Node</h2>
            <p className="text-xs text-slate-500 mt-1.5 leading-relaxed md:hidden">
              Tap the menu icon in the upper-right corner to open the panel and initialize a room session.
            </p>
            <p className="text-xs text-slate-500 mt-1.5 leading-relaxed hidden md:block">
              Use the connection sidebar to create or join a data routing room.
            </p>
          </div>
        )}

        {isHostRole === true && (
          <div className="max-w-5xl mx-auto h-full flex flex-col gap-8">
            <header className="border-b border-slate-800 pb-4">
              <h2 className="text-xl font-bold text-slate-100">Upload Dashboard</h2>
              <p className="text-slate-400 text-xs mt-1">Upload files here to share them instantly with connected peers.</p>
            </header>

            <label className="flex flex-col items-center justify-center py-14 px-8 border-2 border-dashed border-slate-800 rounded-2xl cursor-pointer bg-slate-900/40 hover:bg-slate-900/60 hover:border-indigo-500/80 transition-all duration-300 group shadow-lg">
              <span className="flex flex-col items-center gap-3 text-slate-400 group-hover:text-indigo-400 transition-colors text-center">
                <svg className="w-10 h-10 transform group-hover:-translate-y-1 transition-transform duration-300" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
                </svg>
                <span className="text-xs font-semibold tracking-wider">Select or drag files to upload</span>
              </span>
              <input type="file" multiple onChange={handleFilesAdded} className="hidden" />
            </label>

            <section>
              <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wider border-b border-slate-800 pb-3 mb-4 flex justify-between items-center">
                <span>Shared Files</span>
                <span className="bg-slate-800 text-slate-300 px-2.5 py-0.5 rounded-full text-[11px] border border-slate-700">
                  {hostFiles.length} {hostFiles.length === 1 ? 'file' : 'files'}
                </span>
              </h3>
              {hostFiles.length === 0 ? (
                <p className="text-slate-500 text-xs italic tracking-wide bg-slate-900/20 p-4 rounded-xl border border-slate-800/50">No files uploaded yet.</p>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                  {hostFiles.map(f => (
                    <div key={f.id} className="bg-slate-900 p-4 rounded-xl border border-slate-800 flex items-center justify-between shadow-sm hover:border-slate-700 transition-colors group">
                      <div className="overflow-hidden pr-3 flex-1 min-w-0">
                        <p className="text-slate-200 font-medium truncate text-sm" title={f.name}>{f.name}</p>
                        <span className="text-slate-500 text-xs mt-0.5 block">
                          {(f.size / 1024 / 1024).toFixed(2)} MB
                        </span>
                      </div>
                      <button
                        onClick={() => removeFile(f.id)}
                        title="Remove from catalog"
                        className="ml-2 p-1.5 text-slate-600 hover:text-red-400 hover:bg-red-950/40 rounded-lg border border-transparent hover:border-red-900/40 transition-all opacity-0 group-hover:opacity-100 shrink-0"
                      >
                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                        </svg>
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </section>
          </div>
        )}

        {isHostRole === false && (
          <div className="max-w-5xl mx-auto h-full flex flex-col gap-8">
            <header className="flex flex-col sm:flex-row justify-between sm:items-end gap-4 border-b border-slate-800 pb-4">
              <div>
                <h2 className="text-xl font-bold text-slate-100">Available Downloads</h2>
                <p className="text-slate-400 text-xs mt-1">Files currently shared by the host browser.</p>
              </div>
              {availableFiles.length > 1 && (
                <button
                  onClick={requestAllDownloads}
                  className="bg-indigo-600 hover:bg-indigo-500 text-white px-4 py-2 rounded-xl text-xs font-medium shadow-md transition-all active:scale-95 tracking-wide w-full sm:w-auto text-center"
                >
                  Download All
                </button>
              )}
            </header>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-5">
              {availableFiles.length === 0 ? (
                <div className="col-span-full py-20 flex flex-col items-center justify-center text-slate-500 bg-slate-900/20 rounded-2xl border border-slate-800 text-center px-4">
                  <svg className="w-10 h-10 mb-3 opacity-40 animate-pulse text-indigo-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 100-6 3 3 0 000 6z" />
                  </svg>
                  <p className="text-xs font-medium tracking-wide">Waiting for the host to upload files...</p>
                </div>
              ) : (
                availableFiles.map(f => {
                  const dStatus = downloads[f.id];
                  return (
                    <div key={f.id} className="bg-slate-900 rounded-xl border border-slate-800 relative overflow-hidden shadow-md flex flex-col h-32 hover:border-slate-700 transition-colors">

                      {dStatus && dStatus.status === 'downloading' && (
                        <div className="absolute inset-0 bg-indigo-500/5 z-0 transition-all duration-300" style={{ width: `${dStatus.progress}%` }} />
                      )}

                      <div className="p-4 flex-1 flex flex-col justify-between relative z-10">
                        <div>
                          <p className="text-sm font-semibold text-slate-200 line-clamp-2 leading-snug" title={f.name}>{f.name}</p>
                          <p className="text-xs text-slate-400 mt-1">{(f.size / 1024 / 1024).toFixed(2)} MB</p>
                        </div>

                        <div className="flex justify-end mt-2">
                          {dStatus?.status === 'completed' ? (
                            <div className="flex items-center gap-2">
                              <span className="text-emerald-400 text-xs font-semibold bg-emerald-950/40 px-2.5 py-1 rounded border border-emerald-900/30">Downloaded</span>
                              <button
                                onClick={() => redownload(f.id)}
                                title="Download again"
                                className="p-1.5 text-slate-500 hover:text-indigo-400 hover:bg-indigo-950/40 rounded-lg border border-transparent hover:border-indigo-900/40 transition-all"
                              >
                                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                                </svg>
                              </button>
                            </div>
                          ) : dStatus?.status === 'downloading' ? (
                            <span className="text-blue-400 text-xs font-semibold bg-blue-950/40 px-2.5 py-1 rounded border border-blue-900/30 w-16 text-center tracking-wide">{dStatus.progress}%</span>
                          ) : (
                            <button
                              onClick={() => requestDownload(f.id)}
                              className="bg-indigo-600 hover:bg-indigo-500 text-xs px-3 py-1.5 rounded-lg text-white font-medium transition-colors shadow-sm"
                            >
                              Download
                            </button>
                          )}
                        </div>
                      </div>

                      {dStatus && dStatus.status === 'downloading' && (
                        <div className="w-full h-1 bg-slate-950 absolute bottom-0 left-0">
                          <div className="h-full bg-indigo-500 shadow-[0_0_8px_rgba(99,102,241,0.5)]" style={{ width: `${dStatus.progress}%` }}></div>
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}