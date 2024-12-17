/*
  why:
    runs a sky-blue benchmark on *all* installed models in *all* (kind of) possible context sizes to find bottlenecks/sweetspots.
  start:
    just run "node bench.js"
  needed:
    npm i request
    npm i async
    npm i systeminformation
    npm i express
  modes:
    runBench
      do the benchmarks on client
      send the results to the benchmark collector
      requires 'systeminformation'
    runServer
      start a local server to collect benchmark results
      "upload" needs to be adjusted if not running locally
      someone wants to host this ?
      requires 'express'
  data stored:
    model       the model to test
    num_ctx     the context size to test
    max_ctx     the models max context size
    peval       prompt_eval_count/prompt_eval_duration
    eval        eval_count/eval_duration
    time        the total time in sec
    tps         prompt_eval+eval tps
    vram        vram used while running test
    pgpu        percent running on gpu (100% = good, 99% = bad)
    total_vram  combined vram of all gpus
    gpus        all gpus in the system
  data access:
    http://<host>:3001/get_bench_results
*/

var ollamaHost = "192.168.2.109:11434";
var runBench = true;
var runServer = true;
var upload = "http://127.0.0.1:3001/report_bench_result";
var query = "why is the sky blue ? a short but complete answer.";

require('process').removeAllListeners('warning'); // [DEP0040] DeprecationWarning: The `punycode` module is deprecated.

const fs = require('fs');
var http = require("request");

var results = []
try { results = JSON.parse(fs.readFileSync("results.json", "utf8")); } catch (e) { results=[]; }

function show(host, model, next)   { http.post('http://' + host + '/api/show', {json:{ model: model }}, (error, response, body) => { if (error) return next(error); next(model, body); }); }
function ps(host, next)            { http.get('http://' + host + '/api/ps', (error, response, body) => { if (error) return next(error); next(JSON.parse(body)); }); }
function unload(host, model, next) { http.post('http://' + host + '/api/generate', {json:{ model: model, keep_alive: 0 }}, next); }
function list(host, next)          { http.get('http://' + host + '/api/tags', (error, response, body) => { if (error) return next(error); next(JSON.parse(body)); }); }

if (runBench) {
  var ram = 0, vram = 0, gpus = [];
  function bench(host) {
    console.log("running benchmark on "+host);
    ps(host, (x)=>{ for (let s in x.models) unload(host, x.models[s].model); });
    const queue = require('async').queue((task, completed) => {
      show(host, task.model, (m, d)=>{
        var max_ctx = d.model_info[d.details.family+'.context_length'];
        var options = { seed:0, top_k:10, top_p:0.5, num_ctx:task.num_ctx, repeat_penalty:1.7, repeat_last_n:-1 };
        var p = { model: task.model, messages: [{role:"user","content":query}], options: options, stream: false };
        process.stdout.write((task.model+",").padEnd(43)+max_ctx+",\t"+task.num_ctx+",\t");
        var t = Date.now();
        var next = (error, response, body) => {
          t = parseInt(10*(Date.now()-t)/1000)/10;
          if (error) console.log(error);
          ps(host, (x)=>{
            var pm, gb, p;
            for (let m in x.models) {
              if (task.model == x.models[m].model) {
                pm = x.models[m].model;
                gb = parseInt(10*x.models[m].size/1024/1024/1024)/10;
                p = parseInt(10000*x.models[m].size_vram/x.models[m].size)/100;
                break;
              }
            }
            var pe = parseInt(10*body.prompt_eval_count/(body.prompt_eval_duration/1000000000))/10;
            var e = parseInt(10*body.eval_count/(body.eval_duration/1000000000))/10;
            var tps = parseInt(100*(body.prompt_eval_count+body.eval_count)/((body.prompt_eval_duration+body.eval_duration)/1000000000))/100;
            var result = {model:pm, num_ctx:task.num_ctx, max_ctx:max_ctx, peval:pe, eval:e, tps:tps, used_vram:parseFloat(gb), pgpu:parseFloat(p), time:t, total_vram:parseInt(10*vram/1024)/10, gpus:gpus.join(",")};
            var url = upload+"?"+encodeURIComponent(JSON.stringify(result));
            http.get(url, (x,y)=>{if(x)console.log(x);});
            p = p==100?p+"%":"\x1b[31m"+p+"\x1b[0m";
            console.log(pe+",\t"+e+",\t"+gb+",\t"+p+",\t"+t+",\t"+tps);
            completed(null, task);
          });
        };
        http.post('http://' + host + '/api/chat', { json: p }, next);
      });
    }, 1);
    console.log("model                                     max_ctx\tnum_ctx\tpe/tps\te/tps\tvram\t% GPU\tsecs\ttps");
    list(host, (m)=>{
      var models = [];
      for (let n in m.models) models.push(m.models[n].model);
      models.sort();
      for (let n in models) {
        show(host, models[n], (m, d)=>{
          var max_ctx = d.model_info[d.details.family+'.context_length'];
          for (let a=max_ctx; a>=2048; a/=2) {
            var result=null;
            for (let r in results) {
              if (results[r].model===m && results[r].num_ctx===a) {
                result = results[r];
                break;
              }
            }
            if (!result) queue.push({model:m,num_ctx:a});
            else {
              var pgpu = result.pgpu==100?result.pgpu+"%":"\x1b[31m"+result.pgpu+"%\x1b[0m";
              process.stdout.write((result.model+",").padEnd(43)+result.max_ctx+",\t"+result.num_ctx+",\t");
              console.log(result.peval+",\t"+result.eval+",\t"+result.used_vram+",\t"+pgpu+",\t"+result.time+",\t"+result.tps);
            }
          }
        });
      }
    });
    queue.process();
  }
  const si = require('systeminformation');
  si.cpu().then(cpu => {
    si.mem().then(mem => {
      ram = mem.total;
      console.log(cpu.brand+" / "+parseInt(100*mem.total/1024/1024/1024)/100+" GB");
      si.graphics().then(graphics => {
        for (let c in graphics.controllers) {
          if (graphics.controllers[c].bus=="PCI") {
            vram += graphics.controllers[c].vram;
            gpus.push(graphics.controllers[c].model);
            console.log(graphics.controllers[c].model+" / "+parseInt(100*graphics.controllers[c].vram/1024)/100+"GB");
          }
        }
        bench(ollamaHost);
      }).catch(error => console.error(error));
    }).catch(error => console.error(error));
  }).catch(error => console.error(error));
}

if (runServer) {
  const express = require('express')
  const app = express()
  app.get('/report_bench_result', (req, res) => {
    var data = JSON.parse(decodeURIComponent(req.url).split("?")[1]);
    results.push(data);
    fs.writeFileSync("results.json", JSON.stringify(results,null,4));
    res.status(204).send();
  })
  app.get('/get_bench_results', (req, res) => { res.send(JSON.stringify(results,null,4)); })
  app.listen(3001, () => {console.log("http server: http://localhost:3001/get_bench_results")});
}
