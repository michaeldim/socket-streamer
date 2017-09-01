import gulp from 'gulp'
import babel from 'gulp-babel'
import clean from 'gulp-clean'
import sequence from 'gulp-sequence'
import source from 'vinyl-source-stream'

// set env to production for react production build
// envify doesn't work here
process.env.NODE_ENV = 'production'
process.on('uncaughtException', function(err) {
	console.error('Error caught in uncaughtException event:', err);
})

// compiling tasks
gulp.task('build', sequence('clean', 'compile'))

gulp.task('compile', () => {
  return gulp.src('src/**/*.js')
    .pipe(babel({
      presets: ['es2015'],
      plugins: ['transform-runtime']
    }))
    .pipe(gulp.dest('lib'))
})

// cleaning tasks
gulp.task('clean', () => {
  return gulp.src('lib/**/*.js', {read: false})
    .pipe(clean())
})

// watching tasks
gulp.task('watch', () => {
  let watcher = gulp.watch(['src/**/*.js'], (event) => {
    sequence('clean', 'compile')(err => {
      if (err)
        console.log('*** Watcher - Error ***', err)
    })
  })

  watcher.on('change', event => {
    console.log('*** Watcher - File ' + event.path + ' was ' + event.type + ', compiling... ***')
  })
})
