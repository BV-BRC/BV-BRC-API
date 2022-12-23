module.exports = {
  apps : [{
		name   : "p3_api",
		script : "./app.js",
		cwd: "/p3_api",
		instances: 1,
		exec_mode: "cluster",
		log_file: "/logs/p3_api.log",
		error_file: "NULL",
		out_file: "NULL",
		combine_logs: true,
		kill_timeout : 10000
	},{
		name   : "p3_indexer",
		script : "bin/p3-index-worker",
		cwd: "/p3_api",
		log_file: "/logs/p3_indexer.log",
		error_file: "NULL",
		out_file: "NULL",
		combine_logs: true
	}]
}

