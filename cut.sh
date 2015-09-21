#!/bin/bash

# Copyright (c) 2015 Uber Technologies, Inc.
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in
# all copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
# THE SOFTWARE.

# WHAT DO:
# - bumps last numerical componet in package.json
# - commits package.json
# - updates the node dev branch
# - tags the node dev branch
#
# should / assumed to be ran on master branch
#
# WHAT NEXT:
# - verify
# - git push origin master dev_node --tags
# - git checkout dev_node && npm publish

set -e
set -x

cd -L $(dirname -- $(cd -L -- $(dirname -- $0); pwd))

DEV_BRANCH=dev_hyperbahn

if [ "$1" == "" ]; then
    echo "must pass in version as first arg";
    exit 1;
fi

VERSION=$1
NPM_TAG=$2
node >hyperbahn/package.json.new <<EOF
var data = require("./hyperbahn/package");
data.version = "$VERSION";
console.log(JSON.stringify(data, null, 2));
EOF

mv hyperbahn/package.json.new hyperbahn/package.json

tag=hyperbahn-v$VERSION

git commit hyperbahn/package.json -m "Cut $tag"

localrev=$(env HOME= XDG_CONFIG_HOME= git subtree split --prefix=hyperbahn)
git update-ref "refs/heads/$DEV_BRANCH" "$localrev" -m "Cut $tag"

git tag -a -m "Tag $tag" "$tag" "$DEV_BRANCH"
git push origin master --tags
git push -f origin dev_hyperbahn

git archive --prefix=package/ --format tgz dev_hyperbahn >package.tgz
${NPM:-npm} publish --registry=https://registry.npmjs.org/ package.tgz --tag "${NPM_TAG:-latest}"
rm package.tgz
