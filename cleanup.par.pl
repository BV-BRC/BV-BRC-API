#!/vol/patric3/cli/ubuntu-runtime/bin/perl
use strict;
use warnings;
use Proc::ParallelLoop;
use JSON;
use LWP::UserAgent;
use File::Slurp;
use Getopt::Long;

# Configuration
my $file_data_dir = "file_data";
my $history_dir = "history";
my $keep_count = 1000;
my $max_workers = 4;
my $indexer_url = "http://localhost:3001/indexer";
my $dry_run = 0;
my $read_stdin = 0;

GetOptions(
    "file-data-dir=s" => \$file_data_dir,
    "history-dir=s"   => \$history_dir,
    "keep=i"          => \$keep_count,
    "workers=i"       => \$max_workers,
    "indexer-url=s"   => \$indexer_url,
    "dry-run"         => \$dry_run,
    "stdin"           => \$read_stdin,
    "help"            => sub { usage(); exit 0; },
) or die "Error in command line arguments\n";

sub usage {
    print <<EOF;
Usage: $0 [options]

Options:
    --file-data-dir DIR   Directory containing file data (default: file_data)
    --history-dir DIR     Directory containing history JSON files (default: history)
    --keep N              Number of newest jobs to keep (default: 1000)
    --workers N           Number of parallel workers (default: 4)
    --indexer-url URL     Indexer endpoint URL (default: http://localhost:3001/indexer)
    --dry-run             List IDs that would be processed without making changes
    --stdin               Read the id list from stdin (or pass ids as file args)
                          instead of scanning file_data_dir. Required to consume
                          a piped/redirected list; without it (and without file
                          args) the script always scans file_data_dir. This keeps
                          cron -- which hands the job an empty pipe -- on the scan
                          path instead of reading zero ids from that empty pipe.
    --help                Show this help message

This script (default, no --stdin and no file args):
  1. Lists files in file_data_dir sorted by modification time (newest first)
  2. Skips the newest 'keep' files
  3. For remaining files, checks if state is "submitted" in history/
  4. If so, calls the indexer endpoint to trigger cleanup

With --stdin or file arguments it processes exactly the ids given instead.
EOF
}

# Get list of IDs to process by listing file_data directory sorted by mtime
sub get_ids_to_clean {
    my ($dir, $keep) = @_;

    # Get all files with their modification times
    opendir(my $dh, $dir) or die "Cannot open directory '$dir': $!";
    my @files = grep { /^[a-z0-9]/i && -d "$dir/$_" } readdir($dh);
    closedir($dh);

    # Sort by modification time, newest first (like ls -lt)
    my @sorted = sort {
        (stat("$dir/$b"))[9] <=> (stat("$dir/$a"))[9]
    } @files;
    printf "%d files\n", scalar @files;

    # Skip the newest $keep files, return the rest
    if (@sorted > $keep) {
        return @sorted[$keep .. $#sorted];
    }
    return ();
}

# Subroutine to process each ID
sub process_id {
    my ($id) = @_;

    # Read the state from the JSON file
    my $json_file = "$history_dir/$id";

    if (! -f $json_file) {
        warn "History file not found: $json_file\n";
        return;
    }

    my $json_text = read_file($json_file);
    if (!$json_text) {
        warn "Could not read file '$json_file': $!";
        return;
    }

    my $state;
    eval {
        my $data = decode_json($json_text);
        $state = $data->{state};
    };
    if ($@) {
        warn "Failed to parse JSON for ID $id: $@";
        return;
    }

    # Process the ID if the state is "submitted"
    if ($state && $state eq 'submitted') {
        print "$id\n";

        if ($dry_run) {
            print "  [dry-run] would call $indexer_url/$id\n";
            return;
        }

        # Fetch and process the state using curl-like functionality
        my $ua = LWP::UserAgent->new;
        $ua->timeout(30);
        my $response = $ua->get("$indexer_url/$id");

        if ($response->is_success) {
            my $response_content = $response->decoded_content;
            eval {
                my $response_data = decode_json($response_content);
                print "  state: ", $response_data->{state}, "\n";
            };
            if ($@) {
                warn "Failed to parse response JSON for ID $id: $@";
            }
        } else {
            warn "Failed to fetch data for ID $id: " . $response->status_line;
        }
    }
}

# Main execution
my @ids;

if (@ARGV || $read_stdin) {
    # Read ids from file arguments, or from stdin when --stdin is given.
    # Reading stdin must be explicit: auto-detecting it by stdin type does not
    # work under cron, which hands the job an EMPTY PIPE (not a tty, not
    # /dev/null). Any "is stdin a pipe / not a tty" heuristic therefore matches
    # cron's empty pipe and reads zero ids, cleaning nothing. So default to the
    # internal scan and require --stdin (or file args) to consume a list.
    @ids = <>;
    chomp @ids;
} else {
    # Generate list internally
    print STDERR "Scanning $file_data_dir for files to clean (keeping newest $keep_count)...\n";
    @ids = get_ids_to_clean($file_data_dir, $keep_count);
    print STDERR "Found ", scalar(@ids), " files to process\n";
}

if (@ids == 0) {
    print STDERR "No files to process.\n";
    exit 0;
}

#
# Chunk the ids
#
my $chunk_size = 1000;
my @chunks;

while (@ids)
{
    my @s = splice(@ids, 0, $chunk_size);
    push(@chunks, [@s]);
}

# Use Proc::ParallelLoop to process IDs in parallel
pareach(
    \@chunks,
    sub {
	my $chunk = shift;
	for my $id (@$chunk) {
	    process_id($id);
	}
    },
    { Max_Workers => $max_workers }
);
