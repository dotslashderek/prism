const { tryCatch } = require('fp-ts/lib/TaskEither');

const te = tryCatch(
  () => {
    throw new Error('Sync Error 123!');
  },
  e => e
);

// Execute the thunk
te().then(res => {
  console.log('TaskEither Result:', res);
}).catch(err => {
  console.log('TaskEither Caught Unhandled Promise Rejection:', err);
});
