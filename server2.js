const express = require('express');
const https = require('https'); // http ではなく https
const fs = require('fs');
const path = require('path');
const socketIo = require('socket.io');

const app = express();

// --- 証明書の設定 ---
// Certify The Web や mkcert で書き出したファイルのパスを指定します
const options = {
    // パスは環境に合わせて書き換えてください
    key : fs.readFileSync(path.join(__dirname, 'localhost+1-key.pem')), 
    cert: fs.readFileSync(path.join(__dirname, 'localhost+1.pem'))
};

// --- サーバーの構築 ---
// 1. HTTPSサーバーを作成
const server = https.createServer(options, app);

// 2. Socket.io を HTTPSサーバーに紐付け
const io = socketIo(server, { 
    cors: { 
        origin: "*", // テスト環境用。運用時はドメインを制限することを推奨
        methods: ["GET", "POST"]
    } 
});

// 静的ファイルの提供 (index.html などがある場合)
app.use(express.static(__dirname));

app.get('/', (req, res) => { 
    res.sendFile(path.join(__dirname, 'index.html')); 
});

// // --- WebRTC シグナリング処理 ---
// io.on('connection', (socket) => {
//     console.log('ユーザーが接続しました:', socket.id);

//     socket.on('signal', (data) => {
//         // 送信者以外にシグナリングデータを転送 (P2Pの確立に必要)
//         socket.broadcast.emit('signal', data);
//         console.log('シグナリングデータを転送:', data);
//     });

//     socket.on('disconnect', () => {
//         console.log('ユーザーが切断されました');
//     });
// });

// --- WebRTC シグナリング処理 (ルーム対応) ---
io.on('connection', (socket) => {
    console.log('ユーザー接続:', socket.id);

    // ルームへの参加
    socket.on('join', (roomName) => {
        socket.join(roomName);
        console.log(`ユーザー ${socket.id} がルーム [${roomName}] に参加`);

        // ルーム内の人数を確認
        const clients = io.sockets.adapter.rooms.get(roomName);
        const numClients = clients ? clients.size : 0;

        if (numClients === 2) {
            // 2人目が参加した瞬間に、1人目（先にいた人）にだけ「準備完了」を送る
            // socket.to(roomName) は「自分以外」に送るので、1人目に届く
            socket.to(roomName).emit('ready');
            console.log(`ルーム [${roomName}] が満員になりました。接続を開始します。`);
        }
    });

    // シグナリングデータの転送
    socket.on('signal', (data) => {
        // data = { room: '部屋名', signal: 'SDP/ICEデータ' }
        // 指定されたルームの「自分以外」に転送
        socket.to(data.room).emit('signal', data.signal);
    });

    socket.on('disconnect', () => {
        console.log('ユーザー切断');
    });
});

// --- 起動 ---
const PORT = 8443;
const HOST = '0.0.0.0'; // すべてのネットワークインターフェースで待ち受け

server.listen(PORT, HOST, () => {
    console.log(`-----------------------------------------`);
    console.log(`HTTPS Server running on:`);
    console.log(`- Local:  https://localhost`);
    console.log(`- VPN:    https://100.98.229.112`);
    console.log(`-----------------------------------------`);
});