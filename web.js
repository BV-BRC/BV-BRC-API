const debug = require('debug')('p3api-server:web')

const http = require('http');
const https = require('https');

const Config = require('./config')

module.exports = {
    getSolrAgent: function () {
	const solrAgentConfig = Config.get('solr').agent;
	return this.getSolrAgentForConfig(solrAgentConfig);
    },
    getSolrShortLiveAgent: function () {
	const solrAgentConfig = Config.get('solr').shortLiveAgent;
	return this.getSolrAgentForConfig(solrAgentConfig);
    },
    getSolrAgentForConfig: function(cfg) {
	const parsedUrl = new URL(Config.get('solr').url);
	const reqObj = parsedUrl.protocol === "http:" ? http : https;
	var solrAgent = new reqObj.Agent(cfg);
	return solrAgent;
    }
}

