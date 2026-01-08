const io = require('socket.io-client');
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const URL = 'https://localhost:8444';

const createClient = () => {
    return io(URL, {
        reconnectionDelay: 0,
        forceNew: true,
        transports: ['websocket'],
    });
};

async function testRateLimiting() {
    console.log('--- Testing Rate Limiting ---');

    // Create host to set password
    const host = createClient();

    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            console.error('Timeout: Rate limiting test took too long');
            host.disconnect();
            socket.disconnect();
            resolve(false); // Fail gracefully
        }, 10000);

        host.on('connect', () => {
            host.emit('join', { roomName: 'secure-room-2', password: 'correct' });
        });

        // Wait a bit for host to join
        const socket = createClient();

        setTimeout(() => {
            let attempts = 0;
            const maxAttempts = 6;

            const interval = setInterval(() => {
                attempts++;
                console.log(`Attempt ${attempts} with wrong password...`);
                socket.emit('join', { roomName: 'secure-room-2', password: 'wrong' });

                if (attempts >= maxAttempts) {
                    clearInterval(interval);
                }
            }, 300); // Slightly slower to ensure server processes it

            socket.on('auth-error', (msg) => {
                if (msg.includes('試行回数が多すぎます')) {
                    console.log('✅ Rate limiting verified!');
                    clearTimeout(timeout);
                    host.disconnect();
                    socket.disconnect();
                    resolve(true);
                }
            });
        }, 1500);
    });
}

async function testSignalValidation() {
    console.log('\n--- Testing Signal Validation ---');
    const attacker = createClient();
    const victim = createClient();

    return new Promise((resolve) => {
        const timeout = setTimeout(() => {
            console.log('Test concluded (Success implicit if no failure reported)');
            attacker.disconnect();
            victim.disconnect();
            resolve(true);
        }, 5000);

        victim.on('connect', () => {
            victim.emit('join', { roomName: 'private-room-2', password: 'secret' });
        });

        attacker.on('connect', () => {
            setTimeout(() => {
                console.log('Attacker sending signal to private-room-2...');
                attacker.emit('signal', { room: 'private-room-2', signal: 'FAKE_SIGNAL_DATA' });
            }, 2000);
        });

        victim.on('signal', () => {
            console.error('❌ FAILURE: Victim received signal from non-member!');
            clearTimeout(timeout);
            attacker.disconnect();
            victim.disconnect();
            resolve(false);
        });
    });
}

(async () => {
    try {
        const rateLimitPass = await testRateLimiting();
        if (!rateLimitPass) {
            console.error('Rate Limit Test Failed');
        }

        const signalPass = await testSignalValidation();
        if (!signalPass) {
            console.error('Signal Validation Test Failed');
        }

        if (rateLimitPass && signalPass) {
            console.log('\n✅ All Tests Passed Successfully');
        } else {
            console.log('\n❌ Some Tests Failed');
        }
        process.exit(0);
    } catch (e) {
        console.error('Context Error:', e);
        process.exit(1);
    }
})();
