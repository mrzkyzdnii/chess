import { WebSocketServer } from 'ws'
import http from 'http'
import crypto from 'crypto'

const PORT = Number(process.env.PORT || 3000)
const files = ['a','b','c','d','e','f','g','h']

const rooms = new Map()
const clients = new Map()

const clone = x => JSON.parse(JSON.stringify(x))
const send = (ws, type, data) => {
    if (ws?.readyState === 1) ws.send(JSON.stringify({ type, data, time: Date.now() }))
}
const broadcast = (room, type, data) => {
    for (const ws of room.clients.values()) send(ws, type, data)
}
const roomInfo = room => ({
    id: room.id,
    status: room.status,
    whiteName: room.white?.name || '',
    blackName: room.black?.name || ''
})

const makeId = () => {
    let id
    do id = crypto.randomBytes(3).toString('hex').toUpperCase()
    while (rooms.has(id))
    return id
}

const sq = (r, c) => r >= 0 && r < 8 && c >= 0 && c < 8
const key = (r, c) => `${r},${c}`
const opposite = c => c === 'w' ? 'b' : 'w'
const colorName = c => c === 'w' ? 'White' : 'Black'
const coord = (r, c) => files[c] + (8 - r)

function initialBoard() {
    const b = Array.from({ length: 8 }, () => Array(8).fill(null))
    const back = ['r','n','b','q','k','b','n','r']
    for (let c = 0; c < 8; c++) {
        b[0][c] = { type: back[c], color: 'b' }
        b[1][c] = { type: 'p', color: 'b' }
        b[6][c] = { type: 'p', color: 'w' }
        b[7][c] = { type: back[c], color: 'w' }
    }
    return b
}

function makeGame() {
    return {
        board: initialBoard(),
        turn: 'w',
        castling: { wK: true, wQ: true, bK: true, bQ: true },
        enPassant: null,
        halfmove: 0,
        fullmove: 1,
        history: [],
        positionCounts: new Map(),
        lastMove: null,
        over: false,
        result: null,
        winner: null
    }
}

function snapshot(g) {
    return {
        board: clone(g.board),
        turn: g.turn,
        castling: { ...g.castling },
        enPassant: g.enPassant ? { ...g.enPassant } : null,
        halfmove: g.halfmove,
        fullmove: g.fullmove
    }
}

function restore(g, s) {
    g.board = clone(s.board)
    g.turn = s.turn
    g.castling = { ...s.castling }
    g.enPassant = s.enPassant ? { ...s.enPassant } : null
    g.halfmove = s.halfmove
    g.fullmove = s.fullmove
}

function findKing(g, color) {
    for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
        const p = g.board[r][c]
        if (p?.color === color && p.type === 'k') return { r, c }
    }
    return null
}

function attacked(g, r, c, byColor) {
    const b = g.board
    const pawnDir = byColor === 'w' ? -1 : 1
    const pr = r - pawnDir
    for (const dc of [-1, 1]) {
        const p = b[pr]?.[c + dc]
        if (p?.color === byColor && p.type === 'p') return true
    }

    const knights = [[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]]
    for (const [dr, dc] of knights) {
        const p = b[r + dr]?.[c + dc]
        if (p?.color === byColor && p.type === 'n') return true
    }

    const diagonals = [[-1,-1],[-1,1],[1,-1],[1,1]]
    for (const [dr, dc] of diagonals) {
        let rr = r + dr, cc = c + dc
        while (sq(rr, cc)) {
            const p = b[rr][cc]
            if (p) {
                if (p.color === byColor && (p.type === 'b' || p.type === 'q')) return true
                break
            }
            rr += dr
            cc += dc
        }
    }

    const straights = [[-1,0],[1,0],[0,-1],[0,1]]
    for (const [dr, dc] of straights) {
        let rr = r + dr, cc = c + dc
        while (sq(rr, cc)) {
            const p = b[rr][cc]
            if (p) {
                if (p.color === byColor && (p.type === 'r' || p.type === 'q')) return true
                break
            }
            rr += dr
            cc += dc
        }
    }

    for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
        if (!dr && !dc) continue
        const p = b[r + dr]?.[c + dc]
        if (p?.color === byColor && p.type === 'k') return true
    }
    return false
}

function inCheck(g, color) {
    const k = findKing(g, color)
    return !k || attacked(g, k.r, k.c, opposite(color))
}

function pseudoMoves(g, r, c) {
    const p = g.board[r]?.[c]
    if (!p) return []
    const out = []
    const add = (rr, cc, extra = {}) => {
        if (!sq(rr, cc)) return
        const t = g.board[rr][cc]
        if ((!t || t.color !== p.color) && t?.type !== 'k') out.push({ from:{r,c}, to:{r:rr,c:cc}, captured:t?.type || null, ...extra })
    }

    if (p.type === 'p') {
        const d = p.color === 'w' ? -1 : 1
        const start = p.color === 'w' ? 6 : 1
        const last = p.color === 'w' ? 0 : 7
        if (sq(r+d,c) && !g.board[r+d][c]) {
            if (r+d === last) for (const promotion of ['q','r','b','n']) out.push({ from:{r,c}, to:{r:r+d,c}, captured:null, promotion })
            else out.push({ from:{r,c}, to:{r:r+d,c}, captured:null })
            if (r === start && !g.board[r+2*d][c]) out.push({ from:{r,c}, to:{r:r+2*d,c}, captured:null, pawnDouble:true })
        }
        for (const dc of [-1,1]) {
            const rr = r+d, cc = c+dc
            if (!sq(rr,cc)) continue
            const t = g.board[rr][cc]
            if (t && t.color !== p.color) {
                if (rr === last) for (const promotion of ['q','r','b','n']) out.push({ from:{r,c}, to:{r:rr,c:cc}, captured:t.type, promotion })
                else out.push({ from:{r,c}, to:{r:rr,c:cc}, captured:t.type })
            }
            if (g.enPassant && g.enPassant.r === rr && g.enPassant.c === cc) {
                out.push({ from:{r,c}, to:{r:rr,c:cc}, captured:'p', enPassant:true })
            }
        }
    }

    if (p.type === 'n') {
        for (const [dr,dc] of [[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]]) add(r+dr,c+dc)
    }

    if (p.type === 'b' || p.type === 'r' || p.type === 'q') {
        const dirs = p.type === 'b'
            ? [[-1,-1],[-1,1],[1,-1],[1,1]]
            : p.type === 'r'
                ? [[-1,0],[1,0],[0,-1],[0,1]]
                : [[-1,-1],[-1,1],[1,-1],[1,1],[-1,0],[1,0],[0,-1],[0,1]]
        for (const [dr,dc] of dirs) {
            let rr=r+dr, cc=c+dc
            while (sq(rr,cc)) {
                const t = g.board[rr][cc]
                if (!t) out.push({from:{r,c},to:{r:rr,c:cc},captured:null})
                else {
                    if (t.color !== p.color && t.type !== 'k') out.push({from:{r,c},to:{r:rr,c:cc},captured:t.type})
                    break
                }
                rr+=dr; cc+=dc
            }
        }
    }

    if (p.type === 'k') {
        for (let dr=-1; dr<=1; dr++) for (let dc=-1; dc<=1; dc++) if (dr || dc) add(r+dr,c+dc)
        const row = p.color === 'w' ? 7 : 0
        const enemy = opposite(p.color)
        if (r === row && c === 4 && !inCheck(g, p.color)) {
            const ks = p.color === 'w' ? 'wK' : 'bK'
            if (g.castling[ks] && !g.board[row][5] && !g.board[row][6] &&
                g.board[row][7]?.type === 'r' && g.board[row][7]?.color === p.color &&
                !attacked(g,row,5,enemy) && !attacked(g,row,6,enemy))
                out.push({from:{r,c},to:{r,c:6},captured:null,castle:'K'})
            const qs = p.color === 'w' ? 'wQ' : 'bQ'
            if (g.castling[qs] && !g.board[row][1] && !g.board[row][2] && !g.board[row][3] &&
                g.board[row][0]?.type === 'r' && g.board[row][0]?.color === p.color &&
                !attacked(g,row,3,enemy) && !attacked(g,row,2,enemy))
                out.push({from:{r,c},to:{r,c:2},captured:null,castle:'Q'})
        }
    }

    return out
}

function applyMove(g, m, validate = true) {
    const p = g.board[m.from.r][m.from.c]
    if (!p) return false
    const target = g.board[m.to.r][m.to.c]
    g.board[m.from.r][m.from.c] = null

    if (m.enPassant) {
        const cr = m.from.r
        g.board[cr][m.to.c] = null
    }

    g.board[m.to.r][m.to.c] = { type: m.promotion || p.type, color: p.color }

    if (m.castle) {
        const row = p.color === 'w' ? 7 : 0
        if (m.castle === 'K') {
            g.board[row][5] = g.board[row][7]
            g.board[row][7] = null
        } else {
            g.board[row][3] = g.board[row][0]
            g.board[row][0] = null
        }
    }

    const c = p.color
    if (p.type === 'k') {
        g.castling[c === 'w' ? 'wK' : 'bK'] = false
        g.castling[c === 'w' ? 'wQ' : 'bQ'] = false
    }
    if (p.type === 'r') {
        if (m.from.r === 7 && m.from.c === 0) g.castling.wQ = false
        if (m.from.r === 7 && m.from.c === 7) g.castling.wK = false
        if (m.from.r === 0 && m.from.c === 0) g.castling.bQ = false
        if (m.from.r === 0 && m.from.c === 7) g.castling.bK = false
    }
    if (target?.type === 'r') {
        if (m.to.r === 7 && m.to.c === 0) g.castling.wQ = false
        if (m.to.r === 7 && m.to.c === 7) g.castling.wK = false
        if (m.to.r === 0 && m.to.c === 0) g.castling.bQ = false
        if (m.to.r === 0 && m.to.c === 7) g.castling.bK = false
    }

    g.enPassant = null
    if (p.type === 'p' && Math.abs(m.to.r - m.from.r) === 2)
        g.enPassant = { r:(m.to.r+m.from.r)/2, c:m.from.c }

    g.halfmove = (p.type === 'p' || target || m.enPassant) ? 0 : g.halfmove + 1
    if (c === 'b') g.fullmove++
    g.turn = opposite(c)
    return true
}

function legalMoves(g, r, c) {
    const p = g.board[r]?.[c]
    if (!p) return []
    const result = []
    for (const m of pseudoMoves(g,r,c)) {
        const s = snapshot(g)
        applyMove(g,m,false)
        if (!inCheck(g,p.color)) result.push(m)
        restore(g,s)
    }
    return result
}

function allLegal(g, color = g.turn) {
    const out = []
    for (let r=0;r<8;r++) for (let c=0;c<8;c++) {
        if (g.board[r][c]?.color !== color) continue
        out.push(...legalMoves(g,r,c))
    }
    return out
}

function insufficient(g) {
    const pieces = []
    for (const row of g.board) for (const p of row) if (p) pieces.push(p)
    const nonKings = pieces.filter(p => p.type !== 'k')
    if (!nonKings.length) return true
    if (nonKings.some(p => ['p','q','r'].includes(p.type))) return false
    if (nonKings.length === 1 && ['b','n'].includes(nonKings[0].type)) return true
    if (nonKings.every(p => p.type === 'b')) {
        const squares = []
        for (let r=0;r<8;r++) for (let c=0;c<8;c++) if (g.board[r][c]?.type === 'b') squares.push((r+c)%2)
        return squares.every(x => x === squares[0])
    }
    return false
}

function positionKey(g) {
    const board = g.board.map(row => row.map(p => p ? p.color+p.type : '--').join('')).join('/')
    const cast = Object.entries(g.castling).filter(([,v])=>v).map(([k])=>k).join('')
    const ep = g.enPassant ? `${g.enPassant.r}${g.enPassant.c}` : '-'
    return `${board}|${g.turn}|${cast}|${ep}`
}

function notation(g, m, mover, capture, checkAfter) {
    if (m.castle === 'K') return checkAfter ? 'O-O+' : 'O-O'
    if (m.castle === 'Q') return checkAfter ? 'O-O#' : 'O-O'
    const piece = mover.type === 'p' ? '' : mover.type.toUpperCase()
    const filePart = mover.type === 'p' && (capture || m.enPassant) ? files[m.from.c] : ''
    const cap = capture || m.enPassant ? 'x' : ''
    const promo = m.promotion ? `=${m.promotion.toUpperCase()}` : ''
    const dest = coord(m.to.r,m.to.c)
    return `${piece}${filePart}${cap}${dest}${promo}${checkAfter ? (allLegal(g,g.turn).length ? '+' : '#') : ''}`
}

function finish(g) {
    const moves = allLegal(g,g.turn)
    const check = inCheck(g,g.turn)
    if (!moves.length) {
        g.over = true
        if (check) {
            g.result = 'checkmate'
            g.winner = opposite(g.turn)
        } else {
            g.result = 'stalemate'
            g.winner = null
        }
        return
    }
    if (g.halfmove >= 100) {
        g.over = true
        g.result = 'draw_50move'
        g.winner = null
        return
    }
    if (insufficient(g)) {
        g.over = true
        g.result = 'draw_material'
        g.winner = null
        return
    }
    const pk = positionKey(g)
    if ((g.positionCounts.get(pk) || 0) >= 3) {
        g.over = true
        g.result = 'draw_repetition'
        g.winner = null
    }
}

function gameData(room, ws) {
    const g = room.game
    return {
        roomId: room.id,
        yourColor: room.white?.ws === ws ? 'w' : 'b',
        board: clone(g.board),
        turn: g.turn,
        whiteName: room.white?.name || '',
        blackName: room.black?.name || ''
    }
}

function stateData(g) {
    return {
        board: clone(g.board),
        turn: g.turn,
        lastMove: g.lastMove ? clone(g.lastMove) : null,
        check: inCheck(g,g.turn),
        moveHistory: clone(g.history),
        roomId: room.id,
        yourColor: room.white?.ws === ws ? 'w' : 'b',
        whiteName: room.white?.name || '',
        blackName: room.black?.name || '',
        opponentName: room.white?.ws === ws ? (room.black?.name || 'Lawan') : (room.white?.name || 'Lawan')
    }
}

function startGame(room) {
    room.status = 'playing'
    room.game = makeGame()
    room.game.positionCounts.set(positionKey(room.game),1)
    send(room.white.ws,'game_start',gameData(room,room.white.ws))
    send(room.black.ws,'game_start',gameData(room,room.black.ws))
}

function backToLobby(ws) {
    if (ws?.readyState === 1) send(ws, 'lobby_ready', { ok: true })
}

function finishRoom(room, immediateWs = null, notifyClosed = true, lobbyDelay = 0) {
    if (!room) return
    const players = [room.white?.ws, room.black?.ws].filter(Boolean)
    rooms.delete(room.id)
    room.status = 'finished'
    room.game = null
    room.rematch?.clear()
    room.clients.clear()

    for (const player of players) {
        const c = clients.get(player)
        if (c?.roomId === room.id) c.roomId = null
    }

    if (notifyClosed) {
        for (const player of players) {
            if (player && player !== immediateWs) send(player, 'room_closed', { reason: 'opponent_left' })
        }
    }

    if (immediateWs) backToLobby(immediateWs)
    else if (lobbyDelay > 0) {
        for (const player of players) setTimeout(() => backToLobby(player), lobbyDelay)
    }
}

function destroyWaitingRoom(room, ws = null) {
    if (!room) return
    rooms.delete(room.id)
    room.status = 'finished'
    room.clients.clear()
    room.white = null
    room.black = null
    room.game = null
    if (ws) {
        const c = clients.get(ws)
        if (c?.roomId === room.id) c.roomId = null
        backToLobby(ws)
    }
}

function removeFromRoom(ws, reason = 'disconnect') {
    const client = clients.get(ws)
    if (!client?.roomId) return
    const room = rooms.get(client.roomId)
    if (!room) {
        client.roomId = null
        return
    }

    const wasWhite = room.white?.ws === ws
    const wasBlack = room.black?.ws === ws

    if (room.status === 'playing' && (wasWhite || wasBlack) && room.game && !room.game.over) {
        const winner = wasWhite ? 'b' : 'w'
        room.game.over = true
        room.game.result = reason === 'leave' ? 'abandon' : 'disconnect'
        room.game.winner = winner
        broadcast(room, 'game_over', {
            result: room.game.result,
            winner,
            reason
        })
        finishRoom(room, ws)
        client.roomId = null
        return
    }

    if (room.status === 'waiting') {
        destroyWaitingRoom(room, ws)
        return
    }

    finishRoom(room, ws)
    client.roomId = null
}

const server = http.createServer((req,res) => {
    if (req.url === '/health' || req.url === '/') {
        res.writeHead(200,{'content-type':'application/json'})
        res.end(JSON.stringify({
            status:'ok',
            server:'Chess Online',
            rooms:rooms.size,
            players:[...clients.values()].length,
            uptime:process.uptime()
        }))
        return
    }
    res.writeHead(404,{'content-type':'application/json'})
    res.end(JSON.stringify({status:'not_found'}))
})

const wss = new WebSocketServer({ server })

const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
        if (ws.isAlive === false) { ws.terminate(); continue }
        ws.isAlive = false
        ws.ping()
    }
}, 25000)

wss.on('connection', ws => {
    const clientId = crypto.randomBytes(6).toString('hex')
    let roomId = null
    clients.set(ws,{clientId,roomId})
    ws.isAlive = true
    ws.on('pong', () => { ws.isAlive = true })

    ws.on('message', raw => {
        let msg
        try { msg = JSON.parse(raw.toString()) } catch { return }

        if (msg.type === 'reset_lobby') {
            roomId = null
            const current = clients.get(ws)
            if (current) current.roomId = null
            return
        }

        if (msg.type === 'create_room') {
            if (roomId) return
            const name = String(msg.name || 'Guest').trim().slice(0,18) || 'Guest'
            const id = makeId()
            const room = {
                id,
                name:String(msg.roomName || `${name}'s Room`).trim().slice(0,30) || `${name}'s Room`,
                status:'waiting',
                white:{id:clientId,name,ws},
                black:null,
                clients:new Map([[clientId,ws]]),
                game:null
            }
            rooms.set(id,room)
            roomId=id
            clients.get(ws).roomId=id
            send(ws,'room_created',{roomId:id})
            return
        }

        if (msg.type === 'join_room') {
            if (roomId) return
            const id = String(msg.roomId || '').trim().toUpperCase()
            const room = rooms.get(id)
            const name = String(msg.name || 'Guest').trim().slice(0,18) || 'Guest'
            if (!room || room.status !== 'waiting' || !room.white) {
                send(ws,'error',{message:'ID room tidak tersedia'})
                return
            }
            if (room.white.name.toLowerCase() === name.toLowerCase()) {
                send(ws,'error',{message:'Nama sudah dipakai'})
                return
            }
            room.black={id:clientId,name,ws}
            room.clients.set(clientId,ws)
            roomId=id
            clients.get(ws).roomId=id
            send(ws,'join_accepted',{roomId:id,yourColor:'b',whiteName:room.white.name,blackName:name})
            send(room.white.ws,'opponent_joined',{roomId:id,opponentName:name})
            startGame(room)
            return
        }

        const requestedRoomId = String(msg.roomId || '').trim().toUpperCase()
        const activeRoomId = roomId || requestedRoomId
        const room = activeRoomId ? rooms.get(activeRoomId) : null

        if (room && !roomId) {
            roomId = activeRoomId
            const current = clients.get(ws)
            if (current) current.roomId = activeRoomId
        }

        if (!room) {
            if (msg.type === 'get_state' || msg.type === 'sync') send(ws,'error',{message:'Room tidak ditemukan'})
            return
        }

        if (msg.type === 'get_state' || msg.type === 'sync') {
            if (room.status === 'playing' && room.game) {
                const color = room.white?.ws === ws ? 'w' : room.black?.ws === ws ? 'b' : null
                if (color) send(ws,'game_state',gameData(room,ws))
            }
            return
        }

        if (msg.type === 'leave_room') {
            removeFromRoom(ws,'leave')
            roomId=null
            return
        }

        if (msg.type === 'chat') {
            if (room.status !== 'playing' || !room.game || room.game.over) return
            const text = String(msg.text || '').trim().slice(0,150)
            if (!text) return
            const from = room.white?.ws === ws ? room.white.name : room.black?.name || 'Guest'
            broadcast(room,'chat',{from,text})
            return
        }

        const g = room.game
        const color = room.white?.ws === ws ? 'w' : room.black?.ws === ws ? 'b' : null
        if (!color) return

        if (msg.type === 'rematch') {
            if (room.status !== 'playing' || !g || !g.over) return
            room.rematch ||= new Set()
            if (room.rematch.has(color)) return
            room.rematch.add(color)
            const from = color === 'w' ? room.white?.name : room.black?.name
            if (room.rematch.size >= 2) {
                room.rematch.clear()
                startGame(room)
            } else {
                broadcast(room,'rematch_requested',{from:from || 'Lawan'})
            }
            return
        }

        if (room.status !== 'playing' || !room.game || room.game.over) return

        if (msg.type === 'get_moves') {
            const r = Number(msg.square?.r), c = Number(msg.square?.c)
            if (!sq(r,c) || g.board[r][c]?.color !== color || g.turn !== color) {
                send(ws,'legal_moves',{square:{r,c},moves:[]})
                return
            }
            send(ws,'legal_moves',{square:{r,c},moves:legalMoves(g,r,c).map(m => ({r:m.to.r,c:m.to.c,capture:!!m.captured,promotion:m.promotion || null}))})
            return
        }

        if (msg.type === 'move') {
            if (g.turn !== color) return
            const fr = Number(msg.from?.r), fc = Number(msg.from?.c), tr = Number(msg.to?.r), tc = Number(msg.to?.c)
            if (![fr,fc,tr,tc].every(Number.isInteger) || !sq(fr,fc) || !sq(tr,tc)) return
            const p = g.board[fr][fc]
            if (!p || p.color !== color) return
            let candidates = legalMoves(g,fr,fc).filter(m => m.to.r === tr && m.to.c === tc)
            if (!candidates.length) {
                send(ws,'error',{message:'Langkah tidak valid'})
                return
            }
            const chosen = candidates.find(m => !m.promotion || m.promotion === String(msg.promotion || '').toLowerCase())
            if (!chosen) {
                send(ws,'error',{message:'Pilih promosi'})
                return
            }

            const captured = chosen.captured
            const mover = clone(p)
            applyMove(g,chosen)
            const checkAfter = inCheck(g,g.turn)
            const moveNotation = notation(g,chosen,mover,!!captured,checkAfter)
            g.history.push({
                notation:moveNotation,
                captured:captured || null,
                byColor:color,
                from:chosen.from,
                to:chosen.to
            })
            g.lastMove={from:chosen.from,to:chosen.to}
            const pk = positionKey(g)
            g.positionCounts.set(pk,(g.positionCounts.get(pk)||0)+1)
            finish(g)

            broadcast(room,'game_state',stateData(g))
            if (g.over) {
                broadcast(room,'game_over',{result:g.result,winner:g.winner})
                finishRoom(room, null, false, 3000)
                roomId = null
            }
            return
        }

        if (msg.type === 'resign') {
            const winnerColor = opposite(color)
            const winnerWs = winnerColor === 'w' ? room.white?.ws : room.black?.ws
            g.over = true
            g.result = 'resign'
            g.winner = winnerColor
            broadcast(room,'game_over',{result:'resign',winner:winnerColor})
            finishRoom(room,ws)
            roomId = null
            return
        }

    })

    ws.on('close', () => {
        const current = clients.get(ws)
        if (current?.roomId) removeFromRoom(ws, 'disconnect')
        clients.delete(ws)
    })
})

server.listen(PORT,'0.0.0.0',() => {
    console.log(`Chess Online listening on ${PORT}`)
})
