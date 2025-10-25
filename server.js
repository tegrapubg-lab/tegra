const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, { cors:{ origin:"*" } });

app.use(express.static('public')); // frontend static fayllar

const PORT = process.env.PORT || 3000;
const peers = {};

io.on('connection', socket => {

  // Kirgan foydalanuvchi nick bilan
  socket.on('join', nick => {
    socket.nick = nick;
    io.emit('chat', { nick:'System', msg:`${nick} qo'shildi!` });
  });

  // Text chat
  socket.on('chat', data => io.emit('chat', data));

  // WebRTC signaling
  socket.on('signal', data => {
    const { to, signal } = data;
    io.to(to).emit('signal', { from: socket.id, signal });
  });

  // Tayyor video + audio
  socket.on('ready', () => {
    peers[socket.id] = socket;
    Object.keys(peers).forEach(id => {
      if(id!==socket.id) peers[id].emit('new-peer',{id:socket.id});
    });
  });

  // Disconnect
  socket.on('disconnect', () => {
    delete peers[socket.id];
    io.emit('chat', { nick:'System', msg:`${socket.nick || 'Foydalanuvchi'} ketdi.` });
  });
});

http.listen(PORT, () => console.log(`Server ${PORT} portda ishlayapti`));
