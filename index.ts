import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { streamSSE } from "hono/streaming";
import { getCookie, setCookie } from "hono/cookie";
import { v4 as uuidv4 } from "uuid";
import { createMiddleware } from "hono/factory";

interface BoardState {
  pits: number[];
  stores: [number, number];
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
    pits: Array(12).fill(4),
    stores: [0, 0],
    turn: 0,
    gameOver: false,
    winner: null,
  };
}

function makeMove(
  board: BoardState,
  pitIndex: number,
  player: number,
): BoardState | { error: string } {
  if (board.gameOver) {
    return { error: "Game is over." };
  }
  if (player !== board.turn) {
    return { error: "Not your turn." };
  }
  if (pitIndex < 0 || pitIndex > 11) {
    return { error: "Invalid pit index." };
  }
  const playerPits = player === 0 ? [0, 1, 2, 3, 4, 5] : [6, 7, 8, 9, 10, 11];
  if (!playerPits.includes(pitIndex)) {
    return { error: "Cannot move from opponents pit." };
  }
  if (board.pits[pitIndex] === 0) {
    return { error: "Pit is empty." };
  }

  let seeds = board.pits[pitIndex];
  board.pits[pitIndex] = 0;
  let currentPit = pitIndex;

  while (seeds > 0) {
    currentPit = (currentPit + 1) % 12;
    if (player === 1 && currentPit === 6) currentPit = (currentPit + 1) % 12; // Skip opponent's store
    if (player === 0 && currentPit === 0 && pitIndex !== 0)
      currentPit = (currentPit + 1) % 12; //skip
    board.pits[currentPit]++;
    seeds--;
  }

  // Capture logic
  if (playerPits.includes(currentPit) && board.pits[currentPit] === 1) {
    const oppositePit = 11 - currentPit;
    const capturedSeeds = board.pits[oppositePit];
    board.pits[oppositePit] = 0;
    board.stores[player] += capturedSeeds + 1;
    board.pits[currentPit] = 0;
  }

  // Check for game over
  const player0PitsEmpty = board.pits.slice(0, 6).every((seeds) => seeds === 0);
  const player1PitsEmpty = board.pits
    .slice(6, 12)
    .every((seeds) => seeds === 0);

  if (player0PitsEmpty || player1PitsEmpty) {
    board.gameOver = true;
    if (player0PitsEmpty) {
      board.stores[1] += board.pits.slice(6, 12).reduce((a, b) => a + b, 0);
    } else {
      board.stores[0] += board.pits.slice(0, 6).reduce((a, b) => a + b, 0);
    }
    board.pits.fill(0);
    board.winner =
      board.stores[0] > board.stores[1]
        ? 0
        : board.stores[1] > board.stores[0]
          ? 1
          : null;
  } else {
    if (
      !(player === 0 && currentPit === 5) &&
      !(player === 1 && currentPit === 11)
    )
      board.turn = player === 0 ? 1 : 0; //change player turn.
  }

  return board;
}
const app = new Hono();

// middleware to check if game and session exist
// 404 if no game exists. Create a new session if no sessoin exists.
app.use("/game/:gameId/*", async (c, next) => {
  const { gameId } = c.req.param();
  const game = games[gameId];
  if (!game) {
    return c.json({ error: "Game not found." }, 404);
  }
  let sessionId = getCookie(c, "sessionId");
  if (!sessionId) {
    sessionId = uuidv4();
    setCookie(c, "sessionId", sessionId, {
      httpOnly: true,
      secure: true,
      sameSite: "Strict",
      path: "/",
    });
  }
  c.set("session", { sessionId, game }); // Store session data in context
  await next(); // Proceed to the next middleware or route handler
});
app.get("/", serveStatic({ path: "./public/" }));

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
    path: "/",
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
  const { gameId, pitIndex } = c.req.param();
  const player = parseInt(c.req.query("player") || "-1");
  const { sessionId, game } = c.get("session") as {
    sessionId: string;
    game: Game;
  }; // Retrieve from context

  if (game.playerSessions[player] !== sessionId) {
    //added check
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
  for (let i = 0; i < game.playerSessions.length; i++) {
    if (game.playerSessions[i] === null) {
      game.playerSessions[i] = sessionId;
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

export default app;
