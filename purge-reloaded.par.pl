#!/vol/patric3/cli/ubuntu-runtime/bin/perl
use strict;
use warnings;
use Proc::ParallelLoop;
use JSON;
use File::Slurp;
use File::Path qw(make_path);
use File::Copy qw(move);
use Getopt::Long;

#
# Specialty purge: relocate leftover payload/history for failed jobs that have
# already been reloaded.
#
# Targets jobs that ALL of:
#   * are owned by --owner            (default BVBRC@patricbrc.org)
#   * were queued before --before     (default 2025-08-01, compared to queueTime)
#
# It does NOT delete. For each match it MOVES file_data/<id> to
# <dest>/file_data/<id> and, unless --keep-history, history/<id> to
# <dest>/history/<id>. Review/delete <dest> yourself once satisfied; restore by
# moving back. Scans file_data/ -- the small set of jobs whose payload still
# exists -- not history/, which holds one never-deleted record per genome ever
# submitted.
#
# SAFE BY DEFAULT: prints what it would move and changes nothing unless --confirm
# is given.
#

# Configuration
my $file_data_dir = "file_data";
my $history_dir   = "history";
my $dest_dir;                          # required for --confirm
my $owner         = 'BVBRC@patricbrc.org';
my $before        = '2025-08-01';   # ISO date; queueTime is ISO-8601 UTC, sorts lexically
my $max_workers   = 4;
my $keep_history  = 0;
my $confirm       = 0;

GetOptions(
    "file-data-dir=s" => \$file_data_dir,
    "history-dir=s"   => \$history_dir,
    "dest=s"          => \$dest_dir,
    "owner=s"         => \$owner,
    "before=s"        => \$before,
    "workers=i"       => \$max_workers,
    "keep-history"    => \$keep_history,
    "confirm"         => \$confirm,
    "help"            => sub { usage(); exit 0; },
) or die "Error in command line arguments\n";

sub usage {
    print <<EOF;
Usage: $0 --dest DIR [options]

Relocates leftover file_data (and history) for failed jobs that have already been
reloaded: those owned by a given user and queued before a cutoff date. Nothing is
deleted -- matched jobs are MOVED under --dest so you can review and remove them
yourself, or move them back to restore.

Options:
    --dest DIR            Destination to move matched jobs into. Required with
                          --confirm. Creates DIR/file_data/<id> and
                          DIR/history/<id>.
    --file-data-dir DIR   Directory containing file data (default: file_data)
    --history-dir DIR     Directory containing history JSON files (default: history)
    --owner USER          Only purge jobs whose history 'user' matches
                          (default: BVBRC\@patricbrc.org)
    --before DATE         Only purge jobs queued before this ISO date, compared
                          against the history 'queueTime' (default: 2025-08-01)
    --workers N           Number of parallel workers (default: 4)
    --keep-history        Move only file_data/<id>, leave the history record
    --confirm             Actually move. Without this the script only reports
                          what it would move (dry run).
    --help                Show this help message

Matching a job requires BOTH --owner and --before to hold. A job whose history
is missing/unreadable, or has a different owner or a queueTime on/after the
cutoff, is left untouched.
EOF
}

# List candidate job ids: subdirectories of file_data/.
sub get_job_ids {
    my ($dir) = @_;
    opendir(my $dh, $dir) or die "Cannot open directory '$dir': $!";
    my @ids = grep { /^[a-z0-9]/i && -d "$dir/$_" } readdir($dh);
    closedir($dh);
    return @ids;
}

# Decide whether a single id matches the purge criteria. Returns the matching
# history data hashref, or undef.
sub job_matches {
    my ($id) = @_;

    my $json_file = "$history_dir/$id";
    return undef unless -f $json_file;

    my $text = eval { read_file($json_file) };
    return undef unless defined $text && length $text;

    my $data = eval { decode_json($text) };
    if ($@ || !$data) {
        warn "Failed to parse history for $id: $@" if $@;
        return undef;
    }

    my $job_owner = $data->{user};
    return undef unless defined $job_owner && $job_owner eq $owner;

    my $queued = $data->{queueTime};
    return undef unless defined $queued;
    # queueTime is ISO-8601 UTC (e.g. 2025-07-09T13:03:32.894Z); a lexical
    # compare against the YYYY-MM-DD cutoff is a correct chronological test.
    return undef unless $queued lt $before;

    return $data;
}

# Process (report or move) one id.
sub process_id {
    my ($id) = @_;

    my $data = job_matches($id);
    return unless $data;

    my $genome  = $data->{genomeId} // '?';
    my $queued  = $data->{queueTime} // '?';
    my $fd_src  = "$file_data_dir/$id";
    my $h_src   = "$history_dir/$id";
    my $fd_dst  = "$dest_dir/file_data/$id";
    my $h_dst   = "$dest_dir/history/$id";

    if (!$confirm) {
        print "[dry-run] would move $id (genome=$genome queued=$queued) -> $dest_dir/\n";
        return;
    }

    # Move the payload dir first. If it fails, leave everything in place so the
    # job stays intact and recoverable.
    make_path("$dest_dir/file_data");
    if (-e $fd_dst) {
        warn "Destination $fd_dst already exists; skipping $id\n";
        return;
    }
    unless (move($fd_src, $fd_dst)) {
        warn "Failed to move $fd_src -> $fd_dst: $!\n";
        return;
    }

    unless ($keep_history) {
        make_path("$dest_dir/history");
        if (-e $h_dst) {
            warn "Moved file_data but $h_dst already exists; left history $h_src in place for $id\n";
        } elsif (-f $h_src && !move($h_src, $h_dst)) {
            warn "Moved file_data but failed to move history $h_src -> $h_dst: $!\n";
        }
    }

    print "moved $id (genome=$genome queued=$queued)\n";
}

# Main execution
if ($confirm && !defined $dest_dir) {
    die "--dest DIR is required with --confirm (nothing is deleted; matches are moved there)\n";
}
if (!defined $dest_dir) {
    $dest_dir = '<dest>';   # placeholder for dry-run output only
}

my @ids = get_job_ids($file_data_dir);
print STDERR "Scanning ", scalar(@ids), " file_data job(s): owner=$owner before=$before",
             ($confirm ? " -> $dest_dir" : " (dry run)"), "\n";

if (@ids == 0) {
    print STDERR "No jobs to process.\n";
    exit 0;
}

# Chunk the ids
my $chunk_size = 1000;
my @chunks;
while (@ids) {
    my @s = splice(@ids, 0, $chunk_size);
    push(@chunks, [@s]);
}

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
