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
    key: fs.readFileSync(path.join(__dirname, 'localhost+1-key.pem')),
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


// --- WebRTC シグナリング処理 (ルーム対応) ---
// パスワード管理用オブジェクト { roomName: hashedPassword }
const roomPasswords = {};

// レートリミット管理用 { ipAddress: { count: number, resetTime: number } }
const rateLimits = {};
const RATE_LIMIT_WINDOW = 60 * 1000; // 1分
const MAX_ATTEMPTS = 5; // 1分間に5回まで

const bcrypt = require('bcryptjs');

// --- ログ設定 ---
const LOG_FILE = path.join(__dirname, 'server_log.csv');

function logEvent(message) {
    console.log(message);
    try {
        fs.appendFileSync(LOG_FILE, message + '\n');
    } catch (err) {
        console.error('ログ書き込みエラー:', err);
    }
}

// セキュリティヘッダー設定ミドルウェア
app.use((req, res, next) => {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    next();
});

io.on('connection', (socket) => {
    const clientIp = socket.handshake.address;
    const connectTime = new Date().toLocaleString();
    // CSV Format: Timestamp, Event, SocketID, IP, MAC, RoomName
    logEvent(`${connectTime},CONNECT,${socket.id},${clientIp},-`);

    // ルームへの参加
    socket.on('join', async ({ roomName, password }) => {
        // レートリミットチェック
        // 注: 実運用ではRedisなどを使用することを推奨。ここでは簡易メモリ実装。
        const now = Date.now();
        const limit = rateLimits[clientIp] || { count: 0, resetTime: now + RATE_LIMIT_WINDOW };

        if (now > limit.resetTime) {
            limit.count = 0;
            limit.resetTime = now + RATE_LIMIT_WINDOW;
        }

        if (limit.count >= MAX_ATTEMPTS) {
            socket.emit('auth-error', '試行回数が多すぎます。しばらく待ってから再試行してください。');
            logEvent(`${connectTime},RATE_LIMIT_BLOCK,${socket.id},${clientIp},${roomName}`);
            return;
        }

        // パスワードがない場合はエラー
        if (!roomName || !password) {
            socket.emit('auth-error', 'ルーム名とパスワードを入力してください');
            return;
        }

        const clients = io.sockets.adapter.rooms.get(roomName);
        const numClients = clients ? clients.size : 0;

        // ルームが存在しない、または誰もいない場合 -> 新規作成としてパスワード設定
        if (numClients === 0) {
            // パスワードをハッシュ化して保存
            const salt = await bcrypt.genSalt(10);
            const hash = await bcrypt.hash(password, salt);
            roomPasswords[roomName] = hash;

            socket.join(roomName);
            const time = new Date().toLocaleString();
            logEvent(`${time},JOIN,${socket.id},${clientIp},${roomName}`);

            // 成功通知 (新規ルーム)
            socket.emit('joined', { roomName, isNewRoom: true });
        } else {
            // 既存ルーム -> パスワード確認
            const storedHash = roomPasswords[roomName];

            if (!storedHash) {
                // 万が一ハッシュがない場合（通常ありえないがリカバリ）
                socket.emit('auth-error', 'ルーム情報の取得に失敗しました。別のルーム名を使用してください。');
                return;
            }

            const match = await bcrypt.compare(password, storedHash);

            if (match) {
                // 成功時はレートリミットリセット（オプション）
                // limit.count = 0; 

                socket.join(roomName);
                const time = new Date().toLocaleString();
                logEvent(`${time},JOIN,${socket.id},${clientIp},${roomName}`);

                // 成功通知
                socket.emit('joined', { roomName, isNewRoom: false });

                if (numClients === 1) {
                    // 2人目が参加した瞬間に、1人目（先にいた人）にだけ「準備完了」を送る
                    socket.to(roomName).emit('ready');
                    const time = new Date().toLocaleString();
                    logEvent(`${time},CALL_START,-,-,${roomName}`);
                }
            } else {
                // 失敗カウント加算
                limit.count++;
                rateLimits[clientIp] = limit;

                socket.emit('auth-error', 'パスワードが間違っています');
                const time = new Date().toLocaleString();
                logEvent(`${time},PASSWORD_FAIL,${socket.id},${clientIp},${roomName}`);
                return;
            }
        }
        // レートリミット情報を更新
        rateLimits[clientIp] = limit;
    });

    // シグナリングデータの転送
    socket.on('signal', (data) => {
        // data = { room: '部屋名', signal: 'SDP/ICEデータ' }

        // セキュリティ: 送信元が本当にそのルームに参加しているかチェック
        const rooms = socket.rooms;
        if (!rooms.has(data.room)) {
            console.warn(`不正なシグナリング検知: Socket ${socket.id} は Room ${data.room} に参加していません。`);
            return;
        }

        // 指定されたルームの「自分以外」に転送
        socket.to(data.room).emit('signal', data.signal);
    });

    socket.on('disconnecting', () => {
        // 部屋から退出する前に、部屋が空になるかチェックしてパスワードを削除
        const rooms = socket.rooms;
        // console.log(`User disconnecting: ${socket.id}, Rooms:`, [...rooms]);

        rooms.forEach((roomName) => {
            // socket.roomsには自分のIDも含まれるので除外
            if (roomName !== socket.id) {
                const clients = io.sockets.adapter.rooms.get(roomName);
                const numClients = clients ? clients.size : 0;

                // console.log(`Checking room: ${roomName}, Users: ${numClients}`);

                // 2人 -> 1人になる場合、通話終了とみなす
                if (numClients === 2) {
                    const time = new Date().toLocaleString();
                    logEvent(`${time},CALL_END,-,-,${roomName}`);
                }

                // 自分を含めて1人 = 自分がいなくなれば0人
                // 注: disconnecting時点ではまだ自分が部屋にいるので、人数は1以上のはず
                if (numClients <= 1) {
                    if (roomPasswords[roomName]) {
                        delete roomPasswords[roomName];
                        // console.log(`ルーム [${roomName}] が空になったためパスワード情報を削除しました (Cleanup)`);
                    } else {
                        // console.log(`ルーム [${roomName}] は既にパスワードがありません`);
                    }
                } else {
                    // console.log(`ルーム [${roomName}] はまだ他の人がいるため維持します (人数: ${numClients})`);
                }
            }
        });
    });

    socket.on('disconnect', () => {
        const disconnectTime = new Date().toLocaleString();
        logEvent(`${disconnectTime},DISCONNECT,${socket.id},-,-`);
    });
});

// --- 起動 ---
const PORT = 8443;
const HOST = '0.0.0.0'; // すべてのネットワークインターフェースで待ち受け

server.listen(PORT, HOST, () => {
    console.log(`-----------------------------------------`);
    console.log(`HTTPS Server running on:`);
    console.log(`- Local:  https://localhost:${PORT}`);
    console.log(`- VPN:    https://100.98.229.112:${PORT}`);
    console.log(`-----------------------------------------`);
});