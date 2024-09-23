const path = require("path");
const { Worker, isMainThread } = require("worker_threads");
const express = require("express");
const globalState = require("@app/global");
const { usePinoLogger } = require("@app/libs/logger");
const { serializeHttpReq } = require("./request");
const { ErrorRequestTimeout, ErrorWorkerExit } = require("./exceptions");

module.exports.config = {
    baseUrl: "/",
    defaultPort: 3000,
};

const workerWrapperPath = path.resolve(__dirname, "./worker.js");
const handlerDir = path.resolve(__dirname, "../../http/");
const WorkerManager = {

    maxWorkers: 10,
    currWorker: 0,
    taskQueue: [],
    timeoutMs: 10000,
    useLogger: false,

    createQueueId() {
        const queueCount = this.taskQueue.length;
        const dateTime = Date.now();
        return `q${ queueCount }.${ dateTime }`;
    },

    addTask(handlerPath, req) {
        const queueId = this.createQueueId();
        const useLogger = this.useLogger;
        const workerData = {
            queueId,
            useLogger,
            isApiResource: req.isApiRoute,
            handlerPath: path.join(handlerDir, handlerPath),
            request: serializeHttpReq(req),
        };

        return new Promise((resolve, reject) => {
            this.taskQueue.push({ workerData, resolve, reject });
            this.runNext();
        });
    },

    runNext() {
        if(this.currWorker >= this.maxWorkers || this.taskQueue.length < 1)
            return;
        const { workerData, resolve, reject } = this.taskQueue.shift();
        const { isApiResource } = workerData;
        this.currWorker++;

        const timeoutPromise = new Promise((_, rejectTimeout) => {
            return setTimeout(
                () => rejectTimeout(new ErrorRequestTimeout("request timeout")),
                this.timeoutMs
            );
        });

        const worker = new Worker(workerWrapperPath, { workerData });
        const workerPromise = new Promise((resolveWorker, rejectWorker) => {
            worker.on("message", response => resolveWorker(response));
            worker.on("error", err => rejectWorker(err));
            worker.on("exit", exitCode => {
                if(exitCode !== 0)
                    rejectWorker(new ErrorWorkerExit(`worker stopped with exit code ${ exitCode }`));
            });
        });

        Promise.race([ workerPromise, timeoutPromise ])
            .then(response => {
                resolve(response);
                this.currWorker--;
                this.runNext();
            })
            .catch(err => {
                worker.terminate();

                if(err instanceof ErrorRequestTimeout) {
                    if(isApiResource)
                        resolve( err.toHttpApiResponse() );
                    else
                        resolve( err.toHttpResponse() );
                } else if(err instanceof ErrorWorkerExit) {
                    throw err;
                } else {
                    reject(err);
                }

                this.currWorker--;
                this.runNext();
            })
    },

};

let app = null;
module.exports.defineApp = (setup) => {
    if(typeof setup != "function")
        throw new Error("setup is not function(app)");

    if(!globalState.find("logger.httpServer")) {
        globalState.set("logger.httpServer", usePinoLogger({ disableConsole: true }));
    } else {
        WorkerManager.useLogger = true;
    }

    app = express();
    const waApiRouter = express.Router();
    waApiRouter.use((req, res, next) => {
        req.routerType = "waApiRouter";
        req.isApiRoute = true;
        req.isWaApiRoute = true;
        next();
    });

    const apiRouter = express.Router();
    apiRouter.use((req, res, next) => {
        req.routerType = "apiRouter";
        req.isApiRoute = true;
        req.isWaApiRoute = false;
        next();
    });

    const webRouter = express.Router();
    webRouter.use((req, res, next) => {
        req.routerType = "webRouter";
        req.isApiRoute = false;
        req.isWaApiRoute = false;
        next();
    });

    setup({
        web: webRouter,
        api: apiRouter,
        waApi: waApiRouter,
    });

    const waBotToken = globalState.find("waBotToken", "");
    apiRouter.use(`/wabot${ waBotToken }`, waApiRouter);
    apiRouter.use((req, res) => {
        res.status(404).json({
            error: true,
            code: 404,
            message: "API resource not found",
        });
    });

    webRouter.use("/api", apiRouter);
    app.use(this.config.baseUrl, webRouter);
    app.use((req, res) => {
        res.status(404).send("404 Not Found");
    });
};

module.exports.handleRequest = (handlerPath) => {
    if(!app) throw new Error("app is not initialized yet");
    if(typeof handlerPath != "string")
        throw new Error("handlerPath is not string");
    return (req, res, next) => {
        WorkerManager.addTask(handlerPath, req)
            .then(({ isApiResource, httpCode, data }) => {
                if(isApiResource)
                    res.status(httpCode).json(data);
                else
                    res.status(httpCode).send(data);
            })
            .catch(err => {
                globalState.logger.httpServer.error(err);
                next(err);
            });
    };
};

module.exports.serveApp = ({ port, onServed } = {}) => {
    if(!app) throw new Error("app is not initialized yet");
    if(port && typeof port != "number")
        throw new Error("config.port is not number");
    if(onServed && typeof onServed != "function")
        throw new Error("config.onServed is not function");

    if(!port)
        port = this.config.defaultPort;
    app.listen(port, () => {
        if(!onServed) return;
        onServed({ url: `http://localhost:${ port }/` });
    });
};