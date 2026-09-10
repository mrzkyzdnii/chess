import { WebSocketServer } from 'ws';
import http from 'http';
import crypto from 'crypto';

const PORT = process.env.PORT || 8084;

// ==== Config dunia ====
const WORLD_RADIUS = 1400;          // dunia bulat kayak slither.io
const TICK_MS = 45;                 // ~22 tick/detik simulasi
const BROADCAST_EVERY = 2;          // kirim state tiap 2 tick (~11fps network, tetep mulus krn client interpolasi)
const BASE_SPEED = 2.6;
const BOOST_MULT = 1.9;
const TURN_RATE = 0.16;             // radian/tick, biar belokan halus bukan instan
const SEGMENT_SPACING = 9;
const START_LENGTH = 10;
const MIN_LENGTH_TO_BOOST = 12;
const BOOST_DRAIN_EVERY = 4;        // tiap N tick boost, kepanjangan berkurang 1
const FOOD_COUNT_TARGET = 170;
const FOOD_EAT_PADDING = 6;
const SPAWN_PROTECT_MS = 2500;
const MAX_SEND_SEGMENTS = 90;
const SELF_HIT_SKIP = 16;           // segmen deket kepala diabaikan biar gak mati pas belok tajam
const KILL_BONUS = 8;

const PALETTE = ['#ff4d6d', '#00e756', '#29adff', '#ffec27', '#ff77a8', '#ab5236', '#00e5ff', '#ffa300', '#c084fc', '#4ade80'];
const FOOD_COLORS = ['#ff6b81', '#7bed9f', '#70a1ff', '#eccc68', '#ff9ff3', '#1dd1a1', '#feca57', '#48dbfb'];

const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', server: 'Snake-IO-Mini v1.0', uptime: process.uptime() }));
});

const wss = new WebSocketServer({ server });

function genId() { return 'p_' + crypto.randomBytes(6).toString('hex'); }
function rand(min, max) { return min + Math.random() * (max - min); }
function dist2(ax, ay, bx, by) { const dx = ax - bx, dy = ay - by; return dx * dx + dy * dy; }
function normalizeAngle(a) { while (a > Math.PI) a -= Math.PI * 2; while (a < -Math.PI) a += Math.PI * 2; return a; }

function randomPointInWorld(marginFactor = 0.9) {
    const r = WORLD_RADIUS * marginFactor * Math.sqrt(Math.random());
    const a = Math.random() * Math.PI * 2;
    return { x: Math.cos(a) * r, y: Math.sin(a) * r };
}

function radiusForLength(length) {
    return 7 + Math.min(length, 400) * 0.05;
}

function makeFood(big = false) {
    const p = randomPointInWorld(0.98);
    return {
        id: 'f' + crypto.randomBytes(4).toString('hex'),
        x: p.x, y: p.y,
        r: big ? 7 : 3.5,
        value: big ? 5 : 1,
        color: big ? '#ffd23f' : FOOD_COLORS[Math.floor(Math.random() * FOOD_COLORS.length)]
    };
}

const rooms = new Map();

function getRoom(roomId) {
    if (!rooms.has(roomId)) {
        const room = {
            snakes: new Map(),
            clients: new Map(),
            food: new Map(),
            tickCount: 0,
            tickInterval: null
        };
        for (let i = 0; i < FOOD_COUNT_TARGET; i++) {
            const f = makeFood(Math.random() < 0.08);
            room.food.set(f.id, f);
        }
        room.tickInterval = setInterval(() => tickRoom(room), TICK_MS);
        rooms.set(roomId, room);
    }
    return rooms.get(roomId);
}

function destroyRoomIfEmpty(room) {
    if (room.clients.size === 0) {
        for (const [rid, r] of rooms.entries()) {
            if (r === room) {
                clearInterval(r.tickInterval);
                rooms.delete(rid);
                break;
            }
        }
    }
}

function send(ws, type, data) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type, data, time: Date.now() }));
}

function broadcastChat(room, from, color, text) {
    for (const ws of room.clients.values()) send(ws, 'chat', { from, color, text, time: Date.now() });
}

function broadcastSystem(room, text) {
    for (const ws of room.clients.values()) send(ws, 'system', { text });
}

function spawnSnake(room, id, name, color) {
    let pos = randomPointInWorld(0.55);
    for (let i = 0; i < 12; i++) {
        let ok = true;
        for (const s of room.snakes.values()) {
            if (!s.alive) continue;
            if (dist2(pos.x, pos.y, s.x, s.y) < 220 * 220) { ok = false; break; }
        }
        if (ok) break;
        pos = randomPointInWorld(0.55);
    }
    const angle = Math.random() * Math.PI * 2;
    const path = [];
    const pts = START_LENGTH * SEGMENT_SPACING + 60;
    for (let i = 0; i < pts; i++) {
        path.push({ x: pos.x - Math.cos(angle) * i, y: pos.y - Math.sin(angle) * i });
    }
    return {
        id, name, color,
        x: pos.x, y: pos.y,
        angle, targetAngle: angle,
        length: START_LENGTH,
        growth: 0,
        score: 0,
        boosting: false,
        boostTickCounter: 0,
        alive: true,
        spawnUntil: Date.now() + SPAWN_PROTECT_MS,
        path
    };
}

function dropFoodFromCorpse(room, snake) {
    const step = 3;
    let count = 0;
    for (let i = 0; i < snake.path.length && count < 40; i += step) {
        if (i * (BASE_SPEED) > snake.length * SEGMENT_SPACING) break;
        const p = snake.path[i];
        const jitterX = p.x + rand(-6, 6), jitterY = p.y + rand(-6, 6);
        const f = {
            id: 'f' + crypto.randomBytes(4).toString('hex'),
            x: jitterX, y: jitterY,
            r: 5, value: 3, color: snake.color
        };
        room.food.set(f.id, f);
        count++;
    }
}

function killSnake(room, snake, reason) {
    if (!snake.alive) return;
    snake.alive = false;
    dropFoodFromCorpse(room, snake);
    const ws = room.clients.get(snake.id);
    send(ws, 'died', { score: snake.score, length: snake.length, reason });
    broadcastSystem(room, `💀 ${snake.name} mati (${reason}) — panjang ${snake.length}, skor ${snake.score}`);
}

function ensureFood(room) {
    let tries = 0;
    while (room.food.size < FOOD_COUNT_TARGET && tries < 20) {
        const f = makeFood(Math.random() < 0.06);
        room.food.set(f.id, f);
        tries++;
    }
}

function tickRoom(room) {
    ensureFood(room);
    const now = Date.now();

    for (const snake of room.snakes.values()) {
        if (!snake.alive) continue;

        let diff = normalizeAngle(snake.targetAngle - snake.angle);
        const maxTurn = TURN_RATE;
        if (diff > maxTurn) diff = maxTurn; else if (diff < -maxTurn) diff = -maxTurn;
        snake.angle = normalizeAngle(snake.angle + diff);

        const boosting = !!snake.boosting && snake.length > MIN_LENGTH_TO_BOOST;
        snake.boosting = boosting;
        const speed = boosting ? BASE_SPEED * BOOST_MULT : BASE_SPEED;

        snake.x += Math.cos(snake.angle) * speed;
        snake.y += Math.sin(snake.angle) * speed;

        snake.path.unshift({ x: snake.x, y: snake.y });
        const maxPathLen = Math.ceil((snake.length * SEGMENT_SPACING) / BASE_SPEED) + 80;
        if (snake.path.length > maxPathLen) snake.path.length = maxPathLen;

        if (boosting) {
            snake.boostTickCounter++;
            if (snake.boostTickCounter >= BOOST_DRAIN_EVERY) {
                snake.boostTickCounter = 0;
                if (snake.length > MIN_LENGTH_TO_BOOST) {
                    snake.length -= 1;
                    const tail = snake.path[snake.path.length - 1];
                    if (tail) {
                        const f = { id: 'f' + crypto.randomBytes(4).toString('hex'), x: tail.x, y: tail.y, r: 4, value: 1, color: snake.color };
                        room.food.set(f.id, f);
                    }
                }
            }
        }

        const distFromCenter = Math.hypot(snake.x, snake.y);
        if (distFromCenter > WORLD_RADIUS) {
            killSnake(room, snake, 'nabrak batas dunia');
            continue;
        }

        if (snake.growth > 0) {
            snake.length += 1;
            snake.growth -= 1;
        }

        const headR = radiusForLength(snake.length);
        for (const [fid, food] of room.food.entries()) {
            const rr = headR + food.r + FOOD_EAT_PADDING;
            if (dist2(snake.x, snake.y, food.x, food.y) < rr * rr) {
                room.food.delete(fid);
                snake.growth += food.value;
                snake.score += food.value * 2;
            }
        }
    }

    for (const snake of room.snakes.values()) {
        if (!snake.alive) continue;
        if (now < snake.spawnUntil) continue;
        const headR = radiusForLength(snake.length);

        let died = false;
        for (const other of room.snakes.values()) {
            if (other.id === snake.id || !other.alive) continue;
            if (now < other.spawnUntil) continue;
            const otherR = radiusForLength(other.length);
            const otherLimit = other.length * SEGMENT_SPACING;
            for (let i = 0; i < other.path.length; i += 2) {
                const travelled = i * BASE_SPEED;
                if (travelled > otherLimit) break;
                const seg = other.path[i];
                const rr = headR * 0.75 + otherR * 0.75;
                if (dist2(snake.x, snake.y, seg.x, seg.y) < rr * rr) {
                    killSnake(room, snake, `nabrak badan ${other.name}`);
                    other.score += KILL_BONUS;
                    died = true;
                    break;
                }
            }
            if (died) break;
        }
        if (died) continue;

        const selfLimit = snake.length * SEGMENT_SPACING;
        for (let i = SELF_HIT_SKIP; i < snake.path.length; i += 2) {
            const travelled = i * BASE_SPEED;
            if (travelled > selfLimit) break;
            const seg = snake.path[i];
            if (dist2(snake.x, snake.y, seg.x, seg.y) < (headR * 0.7) * (headR * 0.7)) {
                killSnake(room, snake, 'nabrak badan sendiri');
                break;
            }
        }
    }

    room.tickCount++;
    if (room.tickCount % BROADCAST_EVERY === 0) broadcastState(room);
}

function serializeSnake(s) {
    const totalNeeded = Math.min(Math.max(s.length, 4), MAX_SEND_SEGMENTS);
    const step = Math.max(1, Math.floor(s.path.length / totalNeeded));
    const segs = [];
    for (let i = 0, count = 0; i < s.path.length && count < totalNeeded; i += step, count++) {
        const p = s.path[i];
        segs.push([Math.round(p.x), Math.round(p.y)]);
    }
    return {
        id: s.id, name: s.name, color: s.color,
        x: Math.round(s.x * 10) / 10, y: Math.round(s.y * 10) / 10,
        angle: Math.round(s.angle * 100) / 100,
        r: Math.round(radiusForLength(s.length) * 10) / 10,
        length: s.length,
        score: s.score,
        boosting: !!s.boosting,
        invuln: Date.now() < s.spawnUntil,
        segs
    };
}

function broadcastState(room) {
    const alive = [...room.snakes.values()].filter(s => s.alive);
    const snakesArr = alive.map(serializeSnake);
    const foodArr = [...room.food.values()].map(f => [Math.round(f.x), Math.round(f.y), f.r, f.color]);
    const leaderboard = alive.slice().sort((a, b) => b.score - a.score).slice(0, 8)
        .map(s => ({ name: s.name, score: s.score, color: s.color, length: s.length }));
    const payload = {
        snakes: snakesArr,
        food: foodArr,
        leaderboard,
        world: { radius: WORLD_RADIUS },
        alive: alive.length
    };
    for (const ws of room.clients.values()) send(ws, 'state', payload);
}

wss.on('connection', (ws) => {
    const clientId = genId();
    let joinedRoom = null;
    let joinedName = '';
    let joinedColor = PALETTE[Math.floor(Math.random() * PALETTE.length)];
    let lastDir = 0;

    console.log(`[+] Client: ${clientId}`);

    ws.on('message', (raw) => {
        let msg;
        try { msg = JSON.parse(raw.toString()); } catch (e) { return; }

        // ==== JOIN ====
        if (msg.type === 'join') {
            const roomId = String(msg.room || 'default').slice(0, 100);
            const name = String(msg.name || '').trim().slice(0, 16);
            const room = getRoom(roomId);

            if (!name) {
                send(ws, 'join_error', { message: 'Nama tidak boleh kosong' });
                return;
            }
            const taken = [...room.snakes.values()].some(s => s.alive && s.name.toLowerCase() === name.toLowerCase());
            if (taken) {
                send(ws, 'join_error', { message: `Nama "${name}" sudah dipakai, coba nama lain` });
                return;
            }

            joinedColor = PALETTE[room.clients.size % PALETTE.length];
            const snake = spawnSnake(room, clientId, name, joinedColor);
            room.snakes.set(clientId, snake);
            room.clients.set(clientId, ws);
            joinedRoom = room;
            joinedName = name;

            send(ws, 'joined', { id: clientId, world: { radius: WORLD_RADIUS } });
            broadcastSystem(room, `🐍 ${name} masuk arena`);
            return;
        }

        if (!joinedRoom) return;

        // ==== RESPAWN (setelah mati) ====
        if (msg.type === 'respawn') {
            const already = joinedRoom.snakes.get(clientId);
            if (already && already.alive) return;
            const snake = spawnSnake(joinedRoom, clientId, joinedName, joinedColor);
            joinedRoom.snakes.set(clientId, snake);
            send(ws, 'joined', { id: clientId, world: { radius: WORLD_RADIUS } });
            return;
        }

        const snake = joinedRoom.snakes.get(clientId);
        if (!snake || !snake.alive) return;

        // ==== DIR (arah gerak, radian) ====
        if (msg.type === 'dir') {
            const a = Number(msg.angle);
            if (!Number.isFinite(a)) return;
            const now = Date.now();
            if (now - lastDir < 20) return;
            lastDir = now;
            snake.targetAngle = a;
            return;
        }

        // ==== BOOST ====
        if (msg.type === 'boost') {
            snake.boosting = !!msg.on;
            return;
        }

        // ==== CHAT ====
        if (msg.type === 'chat') {
            const text = String(msg.text || '').slice(0, 200).trim();
            if (!text) return;
            broadcastChat(joinedRoom, joinedName, joinedColor, text);
            return;
        }
    });

    ws.on('close', () => {
        if (joinedRoom) {
            const snake = joinedRoom.snakes.get(clientId);
            joinedRoom.snakes.delete(clientId);
            joinedRoom.clients.delete(clientId);
            if (snake && snake.alive) broadcastSystem(joinedRoom, `${joinedName} keluar arena`);
            destroyRoomIfEmpty(joinedRoom);
        }
        console.log(`[-] Client: ${clientId}`);
    });
});

server.listen(PORT, () => {
    console.log('========================================');
    console.log('  Snake-IO-Mini v1.0 (multiplayer .io snake)');
    console.log(`  Port: ${PORT}`);
    console.log('========================================');
});
