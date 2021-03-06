
import _ from 'lodash';
import Promise from 'bluebird';
import inflection from 'inflection';
import path from 'path';
import {ServerError} from 'ez-error';

let methods = ['get', 'put', 'post', 'delete'];

let defaultOptions = {
  baseRoute: ''
};

class ExpressHandler {
  constructor(expressApp, options) {
    this.expressApp = expressApp;
    this.options = _.defaults(options, defaultOptions);
    this.controllers = {};
  }
  registerControllers(controllers) {
    _.forEach(controllers, (Controller)=> {
      this.registerController(Controller);
    }, this);
  }
  registerBatch(options = {}) {
    let route = options.batchRoute || '/batch';
    let notFound = {
      success: false,
      error: 'NotFound'
    };
    this.expressApp.get(route, (req, res)=> {
      Promise.props(_.mapValues(req.query, (info, keyVal)=> {
        let Controller = this.controllers[info.controller];
        let routeDetails;
        if(!Controller) {
          return notFound;
        }
        let controller;
        try {
          controller = new Controller(info.method);
        } catch(e) {
          if(e.message === 'UndefinedRoute') {
            return notFound;
          }
          throw e;
        }
        if(!controller) {
          return notFound;
        }
        controller.overrideData = info.args;
        return controller.runExpressRoute(req, res);
      })).then( (result)=> {
        res.json(result);
      });
    });
  }
  registerController(Controller) {
    class ExpressController extends Controller {
      constructor(...args) {
        super(...args);
      }
      getData() {
        if(this.overrideData) {
          this.args = this.overrideData;
          return super.getData();
        } else {
          return _.extend({}, this.request.params, this.request.query, this.request.body);
        }
      }
      setStatus(result, success) {
        if(success) {
          this.response.status(this.status || this.finishStatus || 200);
        } else {
          this.response.status(result.status || 500);
        }
      }
      async runExpressRoute(req, res) {
        this.request = req;
        this.response = res;
        var response = {success: true};
        try {
          response.result = await this.runRoute();
        } catch(error) {
          if(!error.isUserError) {
            await this.runLifeCycleMethod('onServerError', this.error);
            error = new ServerError();
          }
          response.success = false;
          response.error = error;
        }
        return response;
      }
      async runExpressRouteAndRender(req, res) {
        let response = await this.runExpressRoute(req, res);
        if(response.success) {
          this.setStatus(response.result, true);
        } else {
          this.setStatus(response.error, false);
        }
        this.runLifeCycleMethod('beforeSendResponse', response);
        let type = this.getRenderType(this.request.path);
        switch(type) {
          case 'csv':
          case 'txt':
            // Think through
            this.renderRaw(response);
          case 'html':
            return this.renderView(response);
          case 'json':
            return this.renderJson(response);
          default:
            throw new Error(`Unknown return type '${type}'`);
        };
      }
      getRenderType(pathname) {
        return path.extname(pathname).substring(1) || 'json';
      }
      renderRaw(response) {
        if(response.success) {
          if(response.result.pipe) {
            return response.result.pipe(this.response);
          } else {
            return this.response.end(response.result);
          }
        } else {
          return this.response.json(response);
        }
      }
      renderView(response) {
        let view = this.routeDetails.view || `${this.tableName}/${this.routeName}`;
        return this.response.render(view, response);
      }
      renderJson(response) {
        if(response.success) {
          response = response.result;
        } else {
          response = {
            error: response.error.message,
            errors: response.error.errors
          };
        }
        return this.response.json(response);
      }
    }
    this.controllers[Controller.modelName] = ExpressController;
    let routes = ExpressController.getAllRoutes('express');
    for(let routeName in routes) {
      let routeDetails = routes[routeName];
      this.registerRoute(routeName, routeDetails, ExpressController);
    }
  }
  registerRoute(routeName, routeDetails, Controller) {
    let routeInfo = this.constructor.getRoutingInfo(Controller, routeName, routeDetails, this.options.baseRoute);
    let {finishStatus, method, pattern} = routeInfo;
    this.expressApp[method](pattern, (req, res)=> {
      let controller = new Controller(routeName);
      controller.finishStatus = finishStatus;
      controller.runExpressRouteAndRender(req, res).catch(function(error) {
        console.log('MajorServerError:', error.stack);
        res.status(500).end();
      }).catch(console.error.bind(console));
    });
  }
  static getRoutingInfo(Controller, routeName, routeDetails, baseRoute = '') {
    let idPattern;
    let basePattern = baseRoute + '/' + Controller.tableName;
    if(Controller.idRegex) {
      idPattern = idRegex === false ? '' : `(${idRegex})`;
    } else {
      idPattern = '([0-9]+)';
    }
    let individualPattern = `${basePattern}/:id${idPattern}`
    let usesId = false;
    let method, pattern;
    let finishStatus = 200;
    switch(routeName) {
      case 'query':
        method = 'get';
        pattern = basePattern;
        break;
      case 'get':
        method = 'get';
        pattern = individualPattern;
        usesId = true;
        break;
      case 'add':
      case 'create':
      case 'post':
        method = 'post';
        pattern = basePattern;
        finishStatus = 201;
        break;
      case 'save':
      case 'update':
      case 'put':
        method = 'put';
        pattern = individualPattern;
        usesId = true;
        break;
      case 'delete':
        method = 'delete';
        pattern = individualPattern;
        usesId = true;
        finishStatus = 202;
        break;
      default:
        let remainingRoute = routeName;
        method = 'get';
        for(let m of methods) {
          if(routeName.indexOf(m) === 0) {
            method = m;
            remainingRoute = routeName.substring(method.length);
            break;
          }
        }
        
        // Convert MakeComment into make-comment
        remainingRoute = inflection.underscore(remainingRoute)
        remainingRoute = inflection.dasherize(remainingRoute)
        
        if(routeDetails.usesId) {
          pattern = individualPattern;
        } else {
          pattern = basePattern;
        }
        pattern += `/${remainingRoute}`;
    }
    let pathPattern;
    if(routeDetails.pattern) {
      pattern = routeDetails.pattern;
      pathPattern = routeDetails.pathPattern;
    } else {
      pathPattern = pattern;
      pattern += '(\.(json|html|csv|txt))?';
    }
    method = routeDetails.method || method;
    return {pattern, method, pathPattern, finishStatus};
  }
};

export default ExpressHandler;
