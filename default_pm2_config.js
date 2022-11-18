module.exports = {
  apps : [{
		name   : "p3_api",
		script : "./app.js",
		cwd: "/p3_api",
		instances: 1,
		exec_mode: "cluster",
		log_file: "/logs/p3_api.log",
		combine_logs: true
	}]
}
