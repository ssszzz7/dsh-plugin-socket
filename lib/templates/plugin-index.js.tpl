'use strict';
module.exports = {
  hello(name) {
    return 'Hello from {{name}}' + (name ? ', ' + name : '') + '!';
  }
};
