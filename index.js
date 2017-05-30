const fs = require('fs')
const path = require('path')
const shell = require('shelljs')
const semver = require('semver')
const eachCons = require('each-cons')
const JiraClient = require('jira-connector')
const compile = require('lodash.template')

const template = compile(fs.readFileSync(path.join(__dirname, 'release-notes.html')).toString())

const jiraHost = 'jira.bcgdv.io'

const jira = new JiraClient( {
    host: 'jira.bcgdv.io',
    basic_auth: {
        username: process.env.JIRA_USER,
        password: process.env.JIRA_PASSWORD
    }
});

// prepare a log command.
const gitlog = 'git log --oneline'

// Look up merge commits to master. These commits are generated when a
// release is made.
// Store date of merge commit for all parent hashes. This is used to
// calculate a release date for a given release.
const masterCommits = shell.exec(`${gitlog} --pretty=format:"%ad %P" --date=short origin/master`, { silent: true }).split('\n').map(c => c.trim())
const mergeCommits = masterCommits.map(c => c.split(' ')).filter(c => c.length === 3)
const commitDateMap = mergeCommits.reduce((map, commit) => {
  const date = commit[0]
  map[commit[1]] = date
  map[commit[2]] = date
  return map
}, {})

const releaseBranches = shell.exec(`
  for branch in \`git for-each-ref --format='%(refname:short)' refs/remotes/origin/release\`; do
    if ${gitlog} -n 1 $branch 2>&1 | grep '^' 2>&1 > /dev/null; then
      echo $branch;
    fi;
  done
`, { silent: true }).stdout.split('\n').map(c => c.trim()).filter(c => c !== '')

// getting unsorted releases in a first step
const unsortedReleases = releaseBranches.map(b => [b.match(/(\d+\.\d+)/)[1] + '.0', b])

// using extra hash to properly sort by release number
const releaseHash = unsortedReleases.reduce((hash, release) => {
  hash[release[0]] = release[1]
  return hash
}, {})

const releases = Object.keys(releaseHash).sort(semver.rcompare).map(v => [v, releaseHash[v]])

const issuesByRelease = eachCons(releases, 2).map(([previous, current]) => {
  // Retrieve list of commits in a release
  const commits = shell.exec(`${gitlog} --merges ${previous[1]}...${current[1]}`, { silent: true }).split('\n')

  // Filter out story ids from merge commit messages
  const issueIds = commits.map((commit) => {
    const matches = commit.match(/Merge pull request.*(PCD-\d+)/)
    return matches ? matches[1] : null
  }).filter(id => Boolean(id))

  // Look up release date for the current release
  const releaseHash = shell.exec(`git show-ref ${current[1]} --hash`, { silent: true }).trim()
  const releaseDate = commitDateMap[releaseHash]
  const branchParts = current[1].split('/')

  return {
    release: branchParts[branchParts.length - 1],
    date: releaseDate,
    issueIds: issueIds
  }
})


let issueMap = {}
jira.search.search({ jql: 'project="PCD"', maxResults: 10000, fields: ['summary'] }, (err, response) => {
  response.issues.map((issue) => {
    issueMap[issue.key] = {
      id: issue.id,
      url: `https://${jiraHost}/browse/${issue.key}`,
      summary: issue.fields.summary
    }
  })

  const rendered = template({
    issuesByRelease,
    issueMap
  })

  console.log(rendered);
})
