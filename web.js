const debug = require('debug')('p3api-server:web')

const http = require('http');
const https = require('https');

const Config = require('./config')
const { registerAgent } = require('./lib/agentStats')

module.exports = {
    getSolrAgent: function () {
	// Registered for /stats: the main data path's pool, whose queue depth is the
	// number Phase 2 sizes against. See lib/agentStats.js. Observation only.
	const solrAgentConfig = Config.get('solr').agent;
	return registerAgent('solr.main', this.getSolrAgentForConfig(solrAgentConfig));
    },
    getSolrShortLiveAgent: function () {
	const solrAgentConfig = Config.get('solr').shortLiveAgent;
	return registerAgent('solr.shortLive', this.getSolrAgentForConfig(solrAgentConfig));
    },
    getSolrAgentForConfig: function(cfg) {
	const parsedUrl = new URL(Config.get('solr').url);
	const reqObj = parsedUrl.protocol === "http:" ? http : https;
	var solrAgent = new reqObj.Agent(cfg);
	return solrAgent;
    }
}

