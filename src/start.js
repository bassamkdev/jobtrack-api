require("dotenv").config();
import express from "express";
import "express-async-errors";
import logger from "loglevel";
import { json, urlencoded } from "body-parser";
import cors from "cors";
import jwt from "express-jwt";
import jwks from "jwks-rsa";
import jwtDecode from "jwt-decode";
import { connect } from "./utils/db";
import { getRoutes } from "./routes";
import { User } from "./resources/user/user.model";

async function startServer({ port = process.env.PORT } = {}) {
  const app = express();

  const attachUser = async (req, res, next) => {
    const token = req.headers.authorization;
    if (!token) {
      return res.status(401).json({ message: "Authentication invalid" });
    }
    const decodedToken = jwtDecode(token.slice(7));
    if (!decodedToken) {
      return res
        .status(401)
        .json({ message: "There was a problem authorizing the request" });
    } else {
      let user = await User.findOne({ userId: decodedToken.sub }).exec();
      if (!user) {
        user = User.create({ userId: decodedToken.sub });
      }
      req.user.sub = user._id;
      next();
    }
  };

  const jwtCheck = jwt({
    secret: jwks.expressJwtSecret({
      cache: true,
      rateLimit: true,
      jwksRequestsPerMinute: 5,
      jwksUri: process.env.AUTH0_JWKS_URI,
    }),
    audience: process.env.AUTH0_AUDIENCE,
    issuer: process.env.AUTH0_ISSUER,
    algorithms: ["RS256"],
  });

  app.use(cors());
  app.use(json());
  app.use(urlencoded({ extended: true }));
  app.use(jwtCheck);
  app.use(attachUser);
  app.use("/api", getRoutes());
  app.use(errorMiddleware);
  // I prefer dealing with promises. It makes testing easier, among other things.
  // So this block of code allows me to start the express app and resolve the
  // promise with the express server
  //   console.log(process.env);
  await connect(process.env.DB_URL);
  return new Promise((resolve) => {
    const server = app.listen(port, () => {
      logger.info(`Listening on port ${server.address().port}`);
      // this block of code turns `server.close` into a promise API
      const originalClose = server.close.bind(server);
      server.close = () => {
        return new Promise((resolveClose) => {
          originalClose(resolveClose);
        });
      };
      // this ensures that we properly close the server when the program exists
      setupCloseOnExit(server);
      // resolve the whole promise with the express server
      resolve(server);
    });
  });
}
// here's our generic error handler for situations where we didn't handle
// errors properly
function errorMiddleware(error, req, res, next) {
  if (res.headersSent) {
    next(error);
  } else {
    logger.error(error);
    res.status(500);
    res.json({
      message: error.message,
      // we only add a `stack` property in non-production environments
      ...(process.env.NODE_ENV === "production"
        ? null
        : { stack: error.stack }),
    });
  }
}
// ensures we close the server in the event of an error.
function setupCloseOnExit(server) {
  // thank you stack overflow
  // https://stackoverflow.com/a/14032965/971592
  async function exitHandler(options = {}) {
    await server
      .close()
      .then(() => {
        logger.info("Server successfully closed");
      })
      .catch((e) => {
        logger.warn("Something went wrong closing the server", e.stack);
      });
    if (options.exit) process.exit();
  }
  // do something when app is closing
  process.on("exit", exitHandler);
  // catches ctrl+c event
  process.on("SIGINT", exitHandler.bind(null, { exit: true }));
  // catches "kill pid" (for example: nodemon restart)
  process.on("SIGUSR1", exitHandler.bind(null, { exit: true }));
  process.on("SIGUSR2", exitHandler.bind(null, { exit: true }));
  // catches uncaught exceptions
  process.on("uncaughtException", exitHandler.bind(null, { exit: true }));
}
export { startServer };
