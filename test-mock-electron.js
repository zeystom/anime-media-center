import path from 'path';
export const app = {
  getPath: (name) => path.join(process.cwd(), '.test_storage', name),
};
export default { app };
