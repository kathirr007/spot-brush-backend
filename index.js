import express from 'express'
import consola from 'consola'
// import { Nuxt, Builder } from 'nuxt'
const app = express()
// const cookiepars = require('cookieparser')
import base64Img from 'base64-img'
import bodyParser from 'body-parser'
import cors from 'cors'
import { fileURLToPath } from 'url';
import path, { dirname } from 'path';

import config from "./backend/config/config.js"
import ReadOnlyBackendService from "./backend/services/ReadOnlyBackendService.js"
import WhiteboardInfoBackendService from "./backend/services/WhiteboardInfoBackendService.js"

import fetch from 'node-fetch'
global.fetch = fetch;
import 'dotenv/config'
// dotenv.config();

/* import nuxtConfig from '../nuxt.config.js'
nuxtConfig['dev'] = process.env.NODE_ENV !== 'production' */

// import * as authService from "./middleware/auth"
import { testRoutes } from './routes/test.js'
import { authRoutes } from './routes/auth.js'

// import startBackendServer from "./backend/server-backend"

import { existsSync, readdirSync, rmdirSync, unlinkSync }  from 'fs'
import { join } from 'path'
import fs from "fs-extra"
import cookieParser from 'cookie-parser'
import formidable from "formidable" //form upload processing

import createDOMPurify from "dompurify" //Prevent xss
import { JSDOM } from "jsdom"
import { createClient } from "webdav"

import  compression from 'compression'
// const helmet = require('helmet');
import s_whiteboard from "./backend/s_whiteboard.js"
import * as httpserver from "http"
import IO from "socket.io"

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const server = httpserver.createServer(app)

const isDir = path => {
  try {
    return statSync(path).isDirectory();
  } catch (error) {
    return false;
  }
};

const getFiles = (path) =>
  readdirSync(path)
    .map(name => join(path, name));

const getDirectories = path =>
  readdirSync(path)
    .map(name => join(path, name))
    .filter(isDir);

const rmDir = path => {
  getDirectories(path).map(dir => rmDir(dir));
  getFiles(path).map(file => unlinkSync(file));
  rmdirSync(path);
};

async function start () {
  const window = new JSDOM("").window;
  const DOMPurify = createDOMPurify(window);

  app.use(compression());
  // app.use(helmet());
  app.use(cookieParser());
  app.use(cors())
  // app.use(express.static('./static/uploads'))
  app.use(express.static(path.join(__dirname, "..", "assets")));
  app.use(bodyParser.json({limit: '50mb'}));
  app.use(bodyParser.urlencoded({limit: '50mb', extended: true}));
  app.use(
    "/uploads",
    // express.static(path.join(__dirname, "..", "static", "uploads"))
    // express.static('./static/uploads')
    express.static(path.join(__dirname, "."))
  );

  // server.listen(port);
  const io = IO(server, {
    serveClient: (process.env.NODE_ENV === 'production') ? false : true,
    path: '/socket.io'
  });
  WhiteboardInfoBackendService.start(io);

  // console.log("Webserver & socketserver running on port:" + port);

  const { accessToken, enableWebdav } = config.backend;

  app.get("/api/loadwhiteboard", function (req, res) {
    // const wid = req["query"]["wid"];
    // const at = req["query"]["at"];
    const wid = req.headers['wid'];
    const at = req.headers['at'];
    if (!at) {
      res.status(401);
      res.end();
    } else if (at && at != "") {
      const widForData = ReadOnlyBackendService.isReadOnly(wid)
        ? ReadOnlyBackendService.getIdFromReadOnlyId(wid)
        : wid;
      const ret = s_whiteboard.loadStoredData(widForData);
      res.json({
        ret: ret,
        email: req.query.email,
        boardName: req.query.wid,
      });
      // res.send(ret);
      // res.end();
    } else {
      res.status(401); //Unauthorized
      res.end();
    }
  });

  app.post("/api/upload", function (req, res) {
    //File upload
    debugger
    var form = new formidable.IncomingForm(); //Receive form
    var formData = {
      files: {},
      fields: {},
    };

    form.on("file", function (name, file) {
      formData["files"][file.name] = file;
    });

    form.on("field", function (name, value) {
      formData["fields"][name] = value;
    });

    form.on("error", function (err) {
      console.log("File uplaod Error!");
    });

    form.on("end", function () {
      if (accessToken === "" || accessToken == formData["fields"]["at"]) {
        progressUploadFormData(formData, function (err) {
          if (err) {
            if (err == "403") {
              res.status(403);
            } else {
              res.status(500);
            }
            res.end();
          } else {
            res.send("done");
          }
        });
      } else {
        res.status(401); //Unauthorized
        res.end();
      }
      //End file upload
    });
    form.parse(req);
  });

  function progressUploadFormData(formData, callback) {
    console.log("Progress new Form Data");
    const fields = escapeAllContentStrings(formData.fields);
    const wid = fields["whiteboardId"];
    if (ReadOnlyBackendService.isReadOnly(wid)) return;

    const readOnlyWid = ReadOnlyBackendService.getReadOnlyId(wid);

    const name = fields["name"] || "";
    const date = fields["date"] || +new Date();
    const filename = `${readOnlyWid}_${date}.png`;
    let webdavaccess = fields["webdavaccess"] || false;
    try {
      webdavaccess = JSON.parse(webdavaccess);
    } catch (e) {
      webdavaccess = false;
    }

    const savingDir = path.join("./public/uploads", readOnlyWid);
    fs.ensureDir(savingDir, function (err) {
      if (err) {
        console.log("Could not create upload folder!", err);
        return;
      }
      let imagedata = fields["imagedata"];
      if (imagedata && imagedata != "") {
        //Save from base64 data
        imagedata = imagedata
          .replace(/^data:image\/png;base64,/, "")
          .replace(/^data:image\/jpeg;base64,/, "");
        console.log(filename, "uploaded");
        const savingPath = path.join(savingDir, filename);
        fs.writeFile(savingPath, imagedata, "base64", function (err) {
          if (err) {
            console.log("error", err);
            callback(err);
          } else {
            if (webdavaccess) {
              //Save image to webdav
              if (enableWebdav) {
                saveImageToWebdav(savingPath, filename, webdavaccess, function (
                  err
                ) {
                  if (err) {
                    console.log("error", err);
                    callback(err);
                  } else {
                    callback();
                  }
                });
              } else {
                callback("Webdav is not enabled on the server!");
              }
            } else {
              callback();
            }
          }
        });
      } else {
        callback("no imagedata!");
        console.log("No image Data found for this upload!", name);
      }
    });
  }

  function saveImageToWebdav(imagepath, filename, webdavaccess, callback) {
    if (webdavaccess) {
      const webdavserver = webdavaccess["webdavserver"] || "";
      const webdavpath = webdavaccess["webdavpath"] || "/";
      const webdavusername = webdavaccess["webdavusername"] || "";
      const webdavpassword = webdavaccess["webdavpassword"] || "";

      const client = createClient(webdavserver, {
        username: webdavusername,
        password: webdavpassword,
      });
      client
        .getDirectoryContents(webdavpath)
        .then((items) => {
          const cloudpath = webdavpath + "" + filename;
          console.log("webdav saving to:", cloudpath);
          fs.createReadStream(imagepath).pipe(
            client.createWriteStream(cloudpath)
          );
          callback();
        })
        .catch((error) => {
          callback("403");
          console.log("Could not connect to webdav!");
        });
    } else {
      callback("Error: no access data!");
    }
  }

  io
  .on("connection", function (socket) {
    // console.log(socket)
    let whiteboardId = null;
    socket.on("disconnect", function () {
      WhiteboardInfoBackendService.leave(socket.id, whiteboardId);
      socket
        .compress(false)
        .broadcast.to(whiteboardId)
        .emit("refreshUserBadges", null); //Removes old user Badges
    });

    socket.on("drawToWhiteboard", function (content) {
      if (!whiteboardId || ReadOnlyBackendService.isReadOnly(whiteboardId))
        return;

      content = escapeAllContentStrings(content);
      if (accessToken === "" || accessToken == content["at"]) {
        const broadcastTo = (wid) =>
          socket
            .compress(false)
            .broadcast.to(wid)
            .emit("drawToWhiteboard", content);
        // broadcast to current whiteboard
        broadcastTo(whiteboardId);
        // broadcast the same content to the associated read-only whiteboard
        const readOnlyId = ReadOnlyBackendService.getReadOnlyId(whiteboardId);
        broadcastTo(readOnlyId);
        s_whiteboard.handleEventsAndData(content); //save whiteboardchanges on the server
      } else {
        socket.emit("wrongAccessToken", true);
      }
    });

    socket.on("joinWhiteboard", function (content) {
      content = escapeAllContentStrings(content);
      if (accessToken === "" || accessToken == content["at"]) {
        // console.log("accessToken :: " + accessToken);
        whiteboardId = content["wid"];

        socket.emit("whiteboardConfig", {
          common: config.frontend,
          whiteboardSpecific: {
            correspondingReadOnlyWid: ReadOnlyBackendService.getReadOnlyId(
              whiteboardId
            ),
            isReadOnly: ReadOnlyBackendService.isReadOnly(whiteboardId),
          },
        });

        socket.join(whiteboardId); //Joins room name=wid
        const screenResolution = content["windowWidthHeight"];
        WhiteboardInfoBackendService.join(
          socket.id,
          whiteboardId,
          screenResolution
        );
      } else {
        socket.emit("wrongAccessToken", true);
      }
    });

    socket.on("updateScreenResolution", function (content) {
      content = escapeAllContentStrings(content);
      if (accessToken === "" || accessToken == content["at"]) {
        const screenResolution = content["windowWidthHeight"];
        WhiteboardInfoBackendService.setScreenResolution(
          socket.id,
          whiteboardId,
          screenResolution
        );
      }
    });
  });

  //Prevent cross site scripting (xss)
  function escapeAllContentStrings(content, cnt) {
    if (!cnt) cnt = 0;

    if (typeof content === "string") {
      return DOMPurify.sanitize(content);
    }
    for (var i in content) {
      if (typeof content[i] === "string") {
        content[i] = DOMPurify.sanitize(content[i]);
      }
      if (typeof content[i] === "object" && cnt < 10) {
        content[i] = escapeAllContentStrings(content[i], ++cnt);
      }
    }
    return content;
  }

  process.on("unhandledRejection", (error) => {
    // Will print "unhandledRejection err is not defined"
    console.log("unhandledRejection", error.message);
  });

  // Init Nuxt.js
  /* const nuxt = new Nuxt(nuxtConfig)
  const { host, port } = nuxt.options.server */

  // Build only in dev mode
  /* if (nuxtConfig.dev) {
    const builder = new Builder(nuxt)
    await builder.build()
  } else {
    await nuxt.ready()
  } */

/*   app.get('/test', (req, res, next) => {
    res.json({
      'message': 'ok'
    })
  }) */

  app.use('/test', testRoutes)
  app.use('/auth', authRoutes)

  app.post('/upload', (req, res) => {
    // debugger
    // rmDir('./static/uploads')
    const { imagedata } = req.body.data;
    base64Img.img(imagedata, './static/uploads', Date.now(), function(err, filepath) {
      // console.log(filepath)
      const pathArr = filepath.indexOf('\\') != -1 ? filepath.split('\\') : filepath.split('/')
      const fileName = pathArr.pop();

      res.status(200).json({
        success: true,
        filepath: filepath,
        url: `${fileName}`
      })
    });
  });

  app.delete('/clearWhiteboard', (req, res, next) => {
    // debugger
    // rmDir('./static/uploads')
    // const { dirUrl } = req.body.dirUrl;
    if(existsSync('./static/uploads')) {
      rmDir('./static/uploads')
      res.json({
        status: 'yes',
        message: `Uploaded files are removed successfully from "./static/uploads".`
      })
    } else {
      res.json({
        status: 'no',
        message: `There are no files to delete...`
      })
    }

  });

  // Give nuxt middleware to express
  // app.use(nuxt.render)

  const port = process.env.PORT || 5500

  // Listen the server
  // server.listen(port, host)

  server.listen(port, () => {
    /* console.log('Webserver & socketserver running on', server.address().port); */
    consola.ready({
      message: `Webserver & socketserver running on  ${'http://localhost'}:${server.address().port
      }`,
      badge: true
    })
  });

  /* consola.ready({
    message: `Webserver & socketserver running on http://${host}:${port}`,
    badge: true
  }) */

}
start()
/* if(nuxtConfig.dev) {
  startBackendServer(3000)
} else {
  startBackendServer(process.env.PORT)
} */
