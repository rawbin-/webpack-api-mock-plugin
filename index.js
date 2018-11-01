/**
 * --------------------------------------------------------------------------- *
 *
 * @Project: BWCloudPrepose-catering
 * @FileName: mock-plugin
 * @Dependence: --
 * @Description: --
 * @CreatedBy: zhangliao
 * @CreateDate: 2017/12/31 下午5:10
 * @LastModifiedBy: zhangliao
 * @LastModifiedDate: 2017/12/31 下午5:10
 *
 * --------------------------------------------------------------------------- *
 */
"use strict";
var sysFs = require('fs');
var jsVm = require('vm');
var sysUtil = require('util');
var sysPath = require('path');
var request = require('request');
var urlParser = require('url');
var queryString = require('querystring');
var _ = require('underscore');
var async = require('async');
var dataEncoding = 'utf-8';
var mockManager = {
    respFuncMap:{
        "proxy_pass":function(confResp,context,done){
            var mockUrlObj = urlParser.parse(confResp);
            var mockQueryStringObj = queryString.parse(mockUrlObj.query);
            var req = context.req;
            var reqUrlObj = urlParser.parse(req.url);
            var reqQueryStringObj = queryString.parse(reqUrlObj.query);
            mockUrlObj.query = queryString.stringify({},mockQueryStringObj,reqQueryStringObj);
            mockUrlObj.search = '?' + mockUrlObj.query;
            var proxyOptions = {
                set_header:{}
            };
            proxyOptions.url = urlParser.format(reqUrlObj);
            proxyOptions.headers = _.extend({},req.headers,{
                host:mockUrlObj.host
            });
            var result,reqMethod = req.method.toUpperCase();
            if(reqMethod === 'GET'){
                result = request.get(proxyOptions).pipe(context.resp);
            }else if(reqMethod === 'POST'){
                result = request.post(proxyOptions).pipe(context.resp);
            }
            return result.on('end',function(){
                return done();
            })
        },
        "raw":function(confResp,context,done){
            var jsonp = context.rule.jsonp || 'callback';
            var queryObj = context.req.query;
            var callback;
            for(var key in queryObj){
                if(key === jsonp){
                    callback = queryObj[key];
                }
            }
            var resp = context.resp;
            var jsonString = mockManager.getContent(confResp);
            if(callback){
                resp.setHeader('Content-Type','application/x-javascript');
                jsonString = [callback,'(',jsonString.trim(),')'].join('');
            }else{
                resp.setHeader('Content-Type','application/json');
            }
            resp.write(jsonString);
            return done();
        },
        "action":function(confResp,context,done){
            if(!sysUtil.isFunction(confResp)){
                var content = mockManager.getContent(confResp);
                var mockRespBuffer = {
                    module:{}
                };
                var baseObj;
                var resp = context.resp;
                try{
                    jsVm.runInNewContext(content,mockRespBuffer);
                    baseObj = mockRespBuffer.module;
                    if(sysUtil.isFunction(baseObj.exports)){
                        baseObj.exports(context.req,resp,context);
                    }else if(sysUtil.isObject(baseObj.exports)){
                        resp.setHeader('Content-Type','application/json');
                        resp.write(JSON.stringify(baseObj.exports),dataEncoding);
                    }else{
                        //TODO
                    }
                }catch(e){
                    console.log('执行',confResp,'失败:',e);
                }
            }else{
                confResp(contex.req,resp,context);
            }
            return done();
        }
    },
    init: function (mockConf) {
        var confFileStat = sysFs.statSync(mockConf);
        this.mockConf = mockConf;
        this.mockConfMtime = confFileStat.mtime;
        this.mockRules = [];
        this.checkInterval = 1000;
        this.doUpdate();
        this.lastCheckTime = new Date();
    },
    getMockRule: function (url) {
        var mockRules = this.mockRules;
        var i, mockConfs, tmpRule, result;
        for (var i = 0, mockConfs = mockRules.length; i < mockConfs; i++) {
            tmpRule = mockRules[i];
            if (sysUtil.isRegExp(tmpRule.pattern)) {
                result = url.match(tmpRule.pattern);
            } else {
                result = url.indexOf(tmpRule.pattern) === 0;
            }
            if (result) {
                return tmpRule;
            }
        }
        return null;
    },
    doResponse: function (mockRule, req, resp, options) {
        var mockResp = mockRule.responder;
        var actionKey = "action";
        if(typeof mockResp === 'string'){
            actionKey = this.getActionKey(mockResp);
        }
        console.log('API REQUEST: ',req.url, ' => mocked to => ', sysPath.resolve(mockResp));
        var respFunc = this.respFuncMap[actionKey];
        var respTasks = [function(seriesCallback){
            return respFunc(mockResp,{
                req:req,
                resp:resp,
                rule:mockRule,
                options:options
            },seriesCallback);
        }];
        return async.series(respTasks,function(err){
            if(err){
                return resp.end(err);
            }else{
                return resp.end();
            }
        });
    },
    getActionKey:function(mockResp){
        var extName = sysPath.extname(mockResp);
        if(/https?:\/\//.test(mockResp)){
            return "proxy_pass";
        }else{
            switch(extName){
                case '.json':
                    return "raw";
                case '.js':
                    return "action";
                default:
                    return "raw"
            }
        }
    },
    doUpdate: function () {
        var self = this;
        var nowMs = new Date();
        if (nowMs - this.lastCheckTime >= self.checkInterval) {
            var checkFileStat = sysFs.statSync(self.mockConf);
            if (checkFileStat.mtime !== self.mockConfMtime) {
                try {
                    var mockConfBuffer = {
                        module:{}
                    };
                    var content = sysFs.readFileSync(this.mockConf, dataEncoding);
                    jsVm.runInNewContext(content, mockConfBuffer);
                    var configObj = mockConfBuffer.module.exports;
                    var tmpRules = configObj.rules || [];
                    var tmpKey, tmpAction;
                    delete configObj.rules;
                    for (tmpKey in configObj) {
                        tmpAction = configObj[tmpKey];
                        tmpRules.push({
                            pattern: tmpKey,
                            responder: tmpAction
                        });
                    }
                    self.mockRules = tmpRules;
                } catch (e) {
                    console.log('mock配置文件出错：', e.toString())
                }
            }
        }
    },
    getContent:function(relativePath){
        var dirname = sysPath.dirname(this.mockConf);
        var filePath = sysPath.join(dirname,relativePath);
        var targetPath;
        if(sysFs.existsSync(filePath)){
            targetPath = filePath;
        }else if(sysFs.existsSync(filePath + '.json')){
            targetPath = filePath + '.json';
        }else if(sysFs.existsSync(filePath + '.js')){
            targetPath = filePath + '.js'
        }else{
            throw new Error('path:' + relativePath + ' not exists')
        }
        return sysFs.readFileSync(targetPath,dataEncoding);
    }
}
function noMock(req, resp, next) {
    return next();
}
module.exports = function (options) {
    var mockConf = options.mockConf;
    if (mockConf) {
        if (!sysFs.existsSync(mockConf)) {
            console.log('mock 配置', mockConf, '不存在');
            return noMock;
        }
    } else {
        return noMock;
    }
    mockManager.init(mockConf);
    return function (req, resp, next) {
        mockManager.doUpdate();
        var mockRule = mockManager.getMockRule(req.url);
        if (mockRule) {
            return mockManager.doResponse(mockRule, req, resp, options);
        } else {
            return next();
        }
    }
}
