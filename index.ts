import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { streamSSE } from "hono/streaming";
import { getCookie, setCookie } from "hono/cookie";
import { v4 as uuidv4 } from "uuid";

interface BoardState {
  pits: number[];
  turn: 0 | 1;
  gameOver: boolean;
  winner: 0 | 1 | null;
}

interface Game {
  board: BoardState;
  listeners: ((board: BoardState) => void)[];
  playerSessions: [string | null, string | null]; // Session IDs for players
}

// In-memory game storage
const games: Record<string, Game> = {};
let nextGameId = 0;
function getInitialBoard(): BoardState {
  return {
    pits: [4, 4, 4, 4, 4, 4, 0, 4, 4, 4, 4, 4, 4, 0],
    turn: 0,
    gameOver: false,
    winner: null,
  };
}

function makeMove(
  board: BoardState,
  pitIndex: number,
  player: number
): BoardState | { error: string } {
  if (board.gameOver) {
    return { error: "Game is over." };
  }
  if (player !== board.turn) {
    return { error: "Not your turn." };
  }
  if (pitIndex < 0 || pitIndex > 12 || pitIndex == 6) {
    return { error: "Invalid pit index." };
  }

  const rangeMin = player * 7;
  const rangeMax = rangeMin + 6;
  if (!(pitIndex >= rangeMin && pitIndex < rangeMax)) {
    return { error: "Cannot move from opponents pit." };
  }
  if (board.pits[pitIndex] === 0) {
    return { error: "Pit is empty." };
  }
  let seeds = board.pits[pitIndex];
  board.pits[pitIndex] = 0;
  let currentPit = pitIndex;

  while (seeds > 0) {
    currentPit = (currentPit + 1) % 14;
    if (player === 1 && currentPit === 6) currentPit = (currentPit + 1) % 14; //skip store
    if (player === 0 && currentPit === 13) currentPit = (currentPit + 1) % 14; // skip store
    board.pits[currentPit]++;
    seeds--;
  }

  // Capture logic
  if (
    currentPit >= rangeMin &&
    currentPit < rangeMax &&
    board.pits[currentPit] === 1
  ) {
    const oppositePit = 13 - currentPit;
    const capturedSeeds = board.pits[oppositePit];
    board.pits[oppositePit] = 0;
    board.pits[(player + 1) * 6 + player] += capturedSeeds + 1;
    board.pits[currentPit] = 0;
  }

  // Check for game over
  const player0PitsEmpty = board.pits.slice(0, 6).every((seeds) => seeds === 0);
  const player1PitsEmpty = board.pits
    .slice(7, 13)
    .every((seeds) => seeds === 0);

  if (player0PitsEmpty || player1PitsEmpty) {
    board.gameOver = true;
    if (player0PitsEmpty) {
      board.pits[13] += board.pits.slice(7, 13).reduce((a, b) => a + b, 0);
    } else {
      board.pits[6] += board.pits.slice(0, 6).reduce((a, b) => a + b, 0);
    }
    board.pits.fill(0);
    board.winner =
      board.pits[6] > board.pits[13]
        ? 0
        : board.pits[13] > board.pits[6]
        ? 1
        : null;
  } else {
    if (
      !(player === 0 && currentPit === 6) &&
      !(player === 1 && currentPit === 14)
    )
      board.turn = player === 0 ? 1 : 0;
  }
  return board;
}
const app = new Hono();

app.use("/public/*", serveStatic({ root: "./" }));

app.get("/", serveStatic({ path: "public" }));

// middleware to check if game and session exist
// 404 if no game exists. Create a new session if no sessoin exists.
app.use("/game/:gameId/*", async (c, next) => {
  const { gameId } = c.req.param();
  const game = games[gameId];
  if (!game) {
    return c.json({ error: "Game not found." }, 404);
  }
  let sessionId = getCookie(c, "sessionId");
  console.log(sessionId);
  if (!sessionId) {
    sessionId = uuidv4();
    setCookie(c, "sessionId", sessionId, {
      httpOnly: true,
      secure: true,
      sameSite: "Strict",
    });
  }
  c.set("session", { sessionId, game }); // Store session data in context
  await next(); // Proceed to the next middleware or route handler
});

// Create a new game (No session check needed here)
app.post("/create", async (c) => {
  const gameId = String(nextGameId++);
  games[gameId] = {
    board: getInitialBoard(),
    listeners: [],
    playerSessions: [null, null], // Initialize session IDs
  };

  const sessionId = uuidv4();
  setCookie(c, "sessionId", sessionId, {
    httpOnly: true,
    secure: true,
    sameSite: "Strict",
  });
  games[gameId].playerSessions[0] = sessionId;

  return c.json({ gameId, player: 0 });
});

// this route gets the board state
app.get("/game/:gameId/state", async (c) => {
  const { gameId } = c.req.param();
  const { game } = c.get("session") as {
    game: Game;
  }; // Retrieve from context

  return c.json(game.board);
});

app.post("/game/:gameId/move/:pitIndex", async (c) => {
  const { pitIndex } = c.req.param();
  const { sessionId, game } = c.get("session") as {
    sessionId: string;
    game: Game;
  }; // Retrieve from context
  console.log(game);
  const player = game.playerSessions.indexOf(sessionId);

  if (player === -1) {
    return c.json({ error: "Invalid player for session." }, 401);
  }

  const result = makeMove(game.board, Number(pitIndex), player);
  if ("error" in result) {
    return c.json(result, 400);
  }

  game.board = result;
  game.listeners.forEach((listener) => listener(game.board));
  return c.json(game.board);
});

app.get("/game/:gameId/events", async (c) => {
  const { gameId } = c.req.param();
  const { sessionId, game } = c.get("session") as {
    sessionId: string;
    game: Game;
  }; // Retrieve from context

  //Check if player slot is taken.
  if (!game.playerSessions.includes(sessionId)) {
    for (let i = 0; i < game.playerSessions.length; i++) {
      if (game.playerSessions[i] === null) {
        game.playerSessions[i] = sessionId;
      }
    }
  }
  return streamSSE(c, async (stream) => {
    const listener = (board: BoardState) => {
      stream.writeSSE({ data: JSON.stringify(board) });
    };
    game.listeners.push(listener);

    while (true) {
      await new Promise((resolve) => setTimeout(resolve, 10000));
      if (game.board.gameOver) {
        const index = game.listeners.indexOf(listener);
        if (index > -1) game.listeners.splice(index, 1);
        break;
      }
    }
  });
});

Bun.serve({
  fetch: app.fetch,
  port: 3000,
  hostname: "0.0.0.0",
});

console.log(`Server running on http://0.0.0.0:${3000}`);
