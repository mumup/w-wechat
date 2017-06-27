const request = require('request').defaults({
    jar: true
})
const parseString = require('xml2js').parseString
const Q = require('q')
const debug = require('debug')('node:wechat')
const fs = require('fs')
const opn = require('opn')
const util = require('util')

//  群聊最大人数
const MAX_GROUP_NUMS = 30
//  搜索间隔
const SEARCH_DELAY = 30 * 1000
//  DEVICE_ID
const DEVICE_ID = 'e000000000000021'
//  验证信息
let BASE_AUTH = {}
//  基础验证信息
let BASE_REQUEST = {}
//  删除列表
let DELETE_LIST = []
//  黑名单列表
let BLACK_LIST = []
//  登录状态
let _tip = 0
//  失败重试次数
const maxRetry = 0
//  基础地址
let BASE_URL = 'https://wx.qq.com/cgi-bin/mmwebwx-bin/'

//  特殊用户
const FILTER_USER = [
    'newsapp', 'fmessage', 'filehelper', 'weibo', 'qqmail',
    'tmessage', 'qmessage', 'qqsync', 'floatbottle', 'lbsapp',
    'shakeapp', 'medianote', 'qqfriend', 'readerapp', 'blogapp',
    'facebookapp', 'masssendapp', 'meishiapp', 'feedsapp',
    'voip', 'blogappweixin', 'weixin', 'brandsessionholder',
    'weixinreminder', 'wxid_novlwrv3lqwv11', 'gh_22b87fa7cb3c',
    'officialaccounts', 'notification_messages', 'wxitil', 'userexperience_alarm'
]

function wait(time) {
    let defer = Q.defer()
    setTimeout(() => {
        defer.resolve()
    }, time)
    return defer.promise
}

//  http 基础类
function fetch(params, cb, retry) {
    if (!retry) retry = 0
    let {
        url,
        method = 'GET',
        qs = null,
        data = '',
        headers = '',
        encoding = 'utf8',
        body = ''
    } = params
    request({
        url: url,
        method: method,
        qs: qs,
        headers: headers,
        encoding: encoding,
        body: body
    }, function (err, res, body) {
        if (!err) debug(`【${method}】###%s`, res.request.uri.href)
        if (!err && res.statusCode === 200) {
            cb(err, res, body)
        } else {
            if (retry < maxRetry) {
                retry += retry
                fetch(params, cb, retry)
            } else {
                cb(err, res, body)
            }
        }
    })
}

//  获取uuid
function getUuid() {
    let defer = Q.defer()
    let params = {
        url: 'https://login.weixin.qq.com/jslogin',
        qs: {
            appid: 'wx782c26e4c19acffb',
            fun: 'new',
            lang: 'zh_CN',
            _: getUnixTime()
        }
    }

    fetch(params, (err, res, body) => {
        if (err) return defer.reject(err)
        let status = parseInt(body.match(/[1-9][0-9]{2,}/)[0])
        if (status === 200) {
            let uuid = body.match(/window.QRLogin.uuid = "(\S+?)"/)[1]
            defer.resolve(uuid)
        } else {
            defer.reject(`【获取uuid失败】`)
        }
    })
    return defer.promise
}

//  获取二维码
async function getQrcode(uuid) {
    let defer = Q.defer()
    let params = {
        url: `https://login.weixin.qq.com/qrcode/${uuid}`,
        encoding: null,
        qs: {
            t: 'webwx',
            _: getUnixTime()
        }
    }
    fetch(params, (err, res, body) => {
        if (err) return defer.reject(err)
        fs.writeFile('code.jpg', body, () => {
            _tip = 1
            opn('code.jpg')
            defer.resolve()
        })
    })
    return defer.promise
}

//  获取二维码(链接)
async function getQrcodeUrl(uuid) {
    return `https://login.weixin.qq.com/l/${uuid}`
}

//  时间戳
function getUnixTime() {
    return Date.now().toString()
}

//  扫描二维码
function scanQcode(uuid) {
    let defer = Q.defer()
    let scanTask = setInterval(function () {
        let params = {
            url: 'https://login.weixin.qq.com/cgi-bin/mmwebwx-bin/login',
            qs: {
                // loginicon: true,<=加这个有base64头像
                tip: _tip,
                uuid: uuid,
                _: getUnixTime()
            }
        }
        fetch(params, (err, res, body) => {
            if (err) return defer.reject(err)
            let m1 = body.match(/window\.code\s*=\s*(\d+)/)
            let code = parseInt(m1 ? m1[1] : -1)
            if (code === 201 && _tip === 1) {
                console.log('【扫码成功，请按登录按钮】')
                _tip = 0
            }
            if (code === 200) {
                global.clearInterval(scanTask)
                let m2 = body.match(/redirect_uri\s*=\s*\"([^\"]+)\"/)
                let ru = m2 ? m2[1] + '&fun=new' : ''
                debug('baseUrl:%s', ru.slice(0, ru.lastIndexOf('/')))
                BASE_URL = ru.slice(0, ru.lastIndexOf('/')) + '/'
                defer.resolve(ru)
            }
        })
    }, 1000)
    return defer.promise
}

//  获取登录信息
function getLoginAuth(url) {
    let defer = Q.defer()
    fetch({
        url: url
    }, (err, res, body) => {
        if (err) return defer.reject(err)
        /*<error>
            <ret>0</ret>
            <message></message>
            <skey>@crypt_ceb3eb67_a331c8f38ea14dc40a3e5bcfb25df759</skey>
            <wxsid>grcyv5yJ18/4Fur+</wxsid>
            <wxuin>438715935</wxuin>
            <pass_ticket>QtVs9VNRj24TQvK4uqJAIGQHBsdFdg7d1TFAtupN1C7243zBoLh%2F31TMvJlPiNS8</pass_ticket>
            <isgrayscale>1</isgrayscale>
        </error>
        */
        parseString(body, function (err, result) {
            result = result.error
            let baseAuth = {
                ret: result.ret[0],
                message: result.message[0],
                skey: result.skey[0],
                wxsid: result.wxsid[0],
                wxuin: result.wxuin[0],
                pass_ticket: result.pass_ticket[0],
                isgrayscale: result.isgrayscale[0]
            }
            debug('baseAuth: %s', baseAuth)
            defer.resolve(baseAuth)
        })
    })
    return defer.promise
}

//  初始化微信
function initWX() {
    let defer = Q.defer()
    let params = {
        url: `${BASE_URL}webwxinit`,
        method: 'POST',
        headers: {
            'Content-Type': 'application/json; charset=UTF-8'
        },
        qs: {
            pass_ticket: BASE_AUTH.pass_ticket,
            skey: BASE_AUTH.skey,
            r: getUnixTime()
        },
        body: JSON.stringify({
            BaseRequest: BASE_REQUEST
        })
    }
    fetch(params, (err, res, body) => {
        if (err) return defer.reject(err)
        let self = JSON.parse(body.toString())
        let {
            Ret,
            ErrMsg
        } = self.BaseResponse
        if (Ret !== 0 && !ErrMsg) {
            defer.reject(ErrMsg || '初始化失败')
        }
        defer.resolve(self.User)
    })
    return defer.promise
}

//  获取所有联系人
function getAllContact() {
    let defer = Q.defer()
    let params = {
        url: `${BASE_URL}webwxgetcontact`,
        qs: {
            pass_ticket: BASE_AUTH.ticket,
            skey: BASE_AUTH.skey,
            r: getUnixTime()
        }
    }
    fetch(params, function (err, res, body) {
        if (err) return defer.reject(err)
        let user = JSON.parse(body.toString())
        let {
            Ret,
            ErrMsg
        } = user.BaseResponse
        if (Ret !== 0 && !ErrMsg) {
            defer.reject(ErrMsg || '获取联系人失败')
        }
        defer.resolve(user.MemberList)
    })
    return defer.promise
}

//  格式化联系人
function filterContact(data) {
    let defer = Q.defer()
    let c1 = data[0]
    let c2 = data[1]
    let fc1 = c1.filter(item =>
        item.VerifyFlag === 0 && //  个人
        item.UserName !== c2.UserName && //  自己
        item.UserName.length < 66 && //  群聊
        !FILTER_USER.find(s => s === item.UserName) //  过滤列表
    )
    if (fc1.length > 0) {
        defer.resolve(fc1)
    } else {
        defer.reject('似乎你的好友清单为空')
    }
    return defer.promise
}

//  开房
function createRoom(memberList) {
    let defer = Q.defer()
    let nameMap = {}
    if (memberList.length > 300) {
        console.log('好友较多,请耐心等待...')
    }
    memberList.sort(() => 0.5 - Math.random())
    let addList = memberList.splice(0, MAX_GROUP_NUMS)
    addList = addList.map((item) => {
        nameMap[item.UserName] = item.NickName
        return {
            'UserName': item.UserName
        }
    })
    request({
        url: `${BASE_URL}webwxcreatechatroom`,
        method: 'POST',
        headers: {
            'Content-Type': 'application/json; charset=UTF-8'
        },
        qs: {
            pass_ticket: BASE_AUTH.pass_ticket,
            skey: BASE_AUTH.skey
        },
        body: JSON.stringify({
            BaseRequest: BASE_REQUEST,
            MemberCount: addList.length,
            MemberList: addList,
            Topic: ''
        })
    }, async function (err, res, body) {
        if (err) defer.reject(err)
        let result = JSON.parse(body)
        if (result.BaseResponse.Ret === 0) {
            let user = result.MemberList
            let roomName = result.ChatRoomName
            user.forEach((item, index) => {
                if (item.MemberStatus === 4) {
                    DELETE_LIST.push(nameMap[item.UserName])
                }
                if (item.MemberStatus === 3) {
                    BLACK_LIST.push(nameMap[item.UserName])
                }
            })
            // { 删除示例
            //     Uin: 0,
            //     UserName: '@f2930da307907f10515cbd88cd566e3c3f83eaf26d18010dd0eae0abbbad0318',
            //     NickName: '',
            //     AttrStatus: 0,
            //     PYInitial: '',
            //     PYQuanPin: '',
            //     RemarkPYInitial: '',
            //     RemarkPYQuanPin: '',
            //     MemberStatus: 4,
            //     DisplayName: '',
            //     KeyWord: ''
            // }
            if (DELETE_LIST.length > 0) {
                console.log(`【目前找到${DELETE_LIST.length}位删除你的好友】`)
                console.log(`${DELETE_LIST.join('\n')}`)
            }
            if (BLACK_LIST.length > 0) {
                console.log(`【目前找到${BLACK_LIST.length}位删除你的好友】`)
                console.log(`${BLACK_LIST.join('\n')}`)
            }
            debug('删除列表: %s', DELETE_LIST.toString())
            await removeMember(addList, roomName)
            defer.resolve({
                memberList: memberList,
                roomName: roomName
            })
        } else {
            defer.reject(result.BaseResponse.ErrMsg)
        }
    })
    return defer.promise
}

//  从群聊中移除
async function removeMember(member, roomName) {
    debug(`移除进程开始`)
    debug(`roomName:%s`, roomName)
    let defer = Q.defer()
    member = member.map(item => item.UserName)
    request({
        url: `${BASE_URL}webwxupdatechatroom`,
        method: 'POST',
        headers: {
            'Content-Type': 'application/json;charset=UTF-8'
        },
        body: JSON.stringify({
            BaseRequest: BASE_REQUEST,
            ChatRoomName: roomName,
            DelMemberList: member.join(',')
        }),
        qs: {
            pass_ticket: BASE_AUTH.pass_ticket,
            fun: 'delmember'
        }
    }, (err, res, body) => {
        let result = JSON.parse(body.toString())
        let ret = result.BaseResponse.Ret
        if (ret === 0) {
            defer.resolve()
        } else {
            debug(`移除错误输出：%s`, body)
            defer.reject(`【移除群聊失败：${result.BaseResponse.ErrMsg || '未知'}】`)
        }
    })
    return defer.promise
}

//  添加入群
async function addMember(member, roomName) {
    let defer = Q.defer()
    let nameMap = {}
    let addList = member.map(item => {
        nameMap[item.UserName] = item.NickName
        return item.UserName
    })
    request({
        url: `${BASE_URL}webwxupdatechatroom`,
        method: 'POST',
        qs: {
            pass_ticket: BASE_AUTH.pass_ticket,
            fun: 'addmember'
        },
        body: JSON.stringify({
            BaseRequest: BASE_REQUEST,
            ChatRoomName: roomName,
            // String [a, b, c]
            AddMemberList: addList.join(',')
        })
    }, (err, res, body) => {
        let result = JSON.parse(body.toString())
        if (result.BaseResponse.Ret === 0) {
            let user = result.MemberList
            user.forEach((item, index) => {
                if (item.MemberStatus === 4) {
                    console.log(item)
                    DELETE_LIST.push(nameMap[item.UserName])
                }
                if (item.MemberStatus === 3) {
                    BLACK_LIST.push(nameMap[item.UserName])
                }
            })
            if (DELETE_LIST.length > 0) {
                console.log(`【目前找到${DELETE_LIST.length}位删除你的好友】`)
                console.log(`${DELETE_LIST.join('\n')}`)
            }
            if (BLACK_LIST.length > 0) {
                console.log(`【目前找到${BLACK_LIST.length}位删除你的好友】`)
                console.log(`${BLACK_LIST.join('\n')}`)
            }
            defer.resolve()
        } else {
            defer.reject(`【添加群聊成员失败：${result.BaseResponse.ErrMsg || '未知'}】`)
        }
    })
    return defer.promise
}

//  退出登录
function wxLogout() {
    console.log('【正在退出微信】')
    let defer = Q.defer()
    let params = {
        url: `${BASE_URL}webwxlogout`,
        method: 'POST',
        qs: {
            redirect: 1,
            type: 0,
            skey: BASE_AUTH.skey
        },
        body: JSON.stringify({
            sid: BASE_AUTH.wxsid,
            uid: BASE_AUTH.wxuin
        })
    }
    fetch(params, (err, res, body) => {
        if (res.statusCode === 301) console.log('【退出成功】')
        else console.log('【退出失败，请手动退出】')
    })
}

//  循环好友
async function loopCheck(params) {
    let {
        memberList,
        roomName
    } = params
    let list = memberList.splice(0, MAX_GROUP_NUMS)
    if (memberList.length > 0) {
        try {
            debug(`添加进程开始`)
            await addMember(list, roomName)
            console.log(`等待【${SEARCH_DELAY / 1000}】秒后继续`)
            await wait(SEARCH_DELAY)
            await removeMember(list, roomName)
        } catch (err) {
            console.log(err)
        }
        loopCheck({
            memberList: memberList,
            roomName: roomName
        })
    } else {
        console.log(`【所有任务完成】\n`)
        console.log(`【已删除你的好友,共${DELETE_LIST.length}】`)
        console.log(`${DELETE_LIST.join('\n')}`)
        console.log(`【已拉黑你的好友,共${BLACK_LIST.length}】`)
        console.log(`${BLACK_LIST.join('\n')}`)
    }
}

(async function () {
    try {
        console.error('【正在获取UUID】')
        let uuid = await getUuid()
        console.log('【正在获取登录二维码】')
        await getQrcode(uuid)
        console.log('【请扫码登录】')
        let loginUrl = await scanQcode(uuid)
        console.log('【正在登录】')
        let loginAuth = await getLoginAuth(loginUrl)
        BASE_AUTH = loginAuth
        BASE_REQUEST = {
            "Uin": parseInt(BASE_AUTH.wxuin),
            "Sid": BASE_AUTH.wxsid,
            "Skey": BASE_AUTH.skey,
            "DeviceID": DEVICE_ID
        }
        console.log('【正在初始化...】')
        let allContact = await Q.all([getAllContact(), initWX()])
        console.log('【正在处理联系人列表...】')
        let filterAfter = await filterContact(allContact)
        console.log('【共找到%s位好友...】', filterAfter.length)
        let roomName = await createRoom(filterAfter)
        console.log('【正在寻找删除/黑名单好友】')
        loopCheck(roomName)
    } catch (err) {
        console.error(err)
        if (BASE_AUTH) wxLogout()
    }
})()