import path from 'path';
export const app = {
  getPath: (name) => path.join(process.cwd(), '.test_storage', name),
};
export const BrowserWindow = class {};
export const Notification = class {
  static isSupported() { return false; }
  show() {}
};
export default { app, BrowserWindow, Notification };
