/*
curl "http://localhost:3001/indexer/genome" \
-X POST -H "Authorization: {}" \
-F 'genome=@./data-files/1005525.3/genome.json' \
-F 'genome_amr=@./data-files/1005525.3/genome_amr.json' \
-F 'genome_feature=@./data-files/1005525.3/genome_feature.json' \
-F 'genome_sequence=@./data-files/1005525.3/genome_sequence.json' \
-F 'pathway=@./data-files/1005525.3/pathway.json' \
-F 'sp_gene=@./data-files/1005525.3/sp_gene.json' \
-F 'subsystem=@./data-files/1005525.3/subsystem.json'
*/
