/**
 * Created by pang on 22/4/2017.
 */

var events = require('events');
var _ = require('lodash')
var eventEmitter = new events.EventEmitter();
var cron = require('node-cron');
var path = require('path')
var tasks = {}
var KongService = require('../services/KongService')
var moment = require('moment')
var nodemailer = require('nodemailer');
var mg = require('nodemailer-mailgun-transport');
var notificationsInterval = 2;
var sendmail = require('sendmail')({
    logger: {
        debug: console.log,
        info: console.info,
        warn: console.warn,
        error: console.error
    },
    silent: false
})

module.exports = {
    emit : function(event,data) {
        eventEmitter.emit(event,data)
    },

    addListener : function(event,fn) {
        eventEmitter.addListener(event, fn);
    },

    start : function(node) {

        if(tasks[node.id] &&  tasks[node.id].isStarted) return false;

        sails.log('Start scheduled health checks for node ' + node.id);
        var self = this;

        if(!tasks[node.id]) {
            tasks[node.id] = {
                cron : self.createCron(node)
            }
        }

        tasks[node.id].timesFailed = 0;
        tasks[node.id].cron.start()
        tasks[node.id].isStarted = true;
    },

    stop : function(node) {
        if(tasks[node.id]) {
            sails.log('Stopping health check for node ' + node.id);
            tasks[node.id].cron.stop()
            tasks[node.id].isStarted = false;
            //delete tasks[node.id]
        }
    },

    createCron : function(node) {

        var self = this;
        return cron.schedule('* * * * *', function() {
            sails.log('Performing health check for node ' + node.id);
            KongService.nodeStatus(node,function(err,data){

                tasks[node.id].lastChecked = new Date();

                if(err) {
                    tasks[node.id].lastFailed = new Date();
                    tasks[node.id].timesFailed++;
                    sails.log('health_checks:cron:checkStatus => Health check for node ' + node.id + ' failed ' + tasks[node.id].timesFailed + ' times');

                    // Start sending notifications the second time a node health check fails
                    // because the first time might be due to a simple restart or something
                    if(tasks[node.id].timesFailed > 1) {
                        var timeDiff = self.getMinutesDiff(new Date(),tasks[node.id].lastNotified)
                        sails.log('health_checks:cron:checkStatus:last notified => ' + tasks[node.id].lastNotified);
                        sails.log('health_checks:cron:checkStatus => Checking if eligible for notification',timeDiff);
                        if(!tasks[node.id].lastNotified || timeDiff > notificationsInterval) {
                            self.notify(node)
                        }
                    }
                }else{
                    sails.log('Health check for node ' + node.id + ' succeeded',data);
                    tasks[node.id].timesFailed = 0;
                    tasks[node.id].lastSucceeded = new Date();
                }

                self.updateNodeHealthCheckDetails(node.id)
            })
        })
    },

    updateNodeHealthCheckDetails : function(nodeId) {

        var data = _.cloneDeep(tasks[nodeId])
        delete(data.cron)

        sails.models.kongnode.update({id: nodeId},{
            health_check_details : data
        }).exec(function(err,updated){
            // Fire and forger for now
            if(err) {
                sails.log("health_checks:updateNodeHealthCheckDetails:failed",err)
            }
        })
    },

    createTransporter : function(cb) {

        // Get active transport
        sails.models.settings.find().limit(1)
            .exec(function(err,settings){
                if(err) return cb(err)
                sails.log("helath_checks:createTransporter:settings =>",settings)
                if(!settings.length || !settings[0].data || !settings[0].data.email_notifications) return cb()
                sails.log("helath_checks:createTransporter => trying to get transport",{
                    "notifications_enabled" : settings[0].data.email_notifications,
                    "transport_name" : settings[0].data.default_transport
                })
                sails.models.emailtransport.findOne({
                    name : settings[0].data.default_transport
                }).exec(function(err,transport){
                    if(err) return cb(err)

                    sails.log("health_checks:createTransporter:transport =>",transport)
                    if(!transport) return cb()

                    var result = {
                        transport : settings[0].data.default_transport,
                    }

                    switch(settings[0].data.default_transport) {
                        case "smtp":
                            result.transporter = nodemailer.createTransport(transport.settings)
                            break;
                        case "mailgun":
                            result.transporter = nodemailer.createTransport(mg(transport.settings))
                            break;
                    }

                    return cb(null,result);

                })
            })

    },

    notify : function(node) {

        var self = this

        self.createTransporter(function(err,result){
            if(err || !result) {
                sails.log("health_check:failed to create transporter. No notification will be sent.",err)
            }else{
                var transporter = result.transporter
                var html = self.makeNotificationHTML(node)

                self.getAdminEmailsList(function(err,receivers){
                    sails.log("health_checks:notify:receivers => ",  receivers)
                    if(!err && receivers.length) {

                        var mailOptions = {
                            from: '"Konga" <noreply@konga.io>', // sender address
                            to: receivers.join(","), // list of receivers
                            subject: 'A node is down or unresponsive', // Subject line
                            html: html
                        };

                        if(result.transport == 'sendmail') {
                            sendmail(mailOptions, function(err, reply) {
                                if(err){
                                    sails.log.error("Health_checks:notify:error",err)
                                }else{
                                    sails.log.info("Health_checks:notify:success",reply)
                                    tasks[node.id].lastNotified = new Date();
                                    self.updateNodeHealthCheckDetails(node.id)

                                }
                            });
                        }else{
                            transporter.sendMail(mailOptions, function(error, info){
                                if(error){
                                    sails.log.error("Health_checks:notify:error",error)

                                }else{
                                    sails.log.info("Health_checks:notify:success",info)
                                    tasks[node.id].lastNotified = new Date();
                                    self.updateNodeHealthCheckDetails(node.id)

                                }
                            });
                        }
                    }
                })
            }
        })
    },

    makeNotificationHTML : function makeNotificationHTML(node) {

        var duration = moment.duration(moment().diff(moment(tasks[node.id].lastSucceeded))).humanize()

        var html = '<p>A Kong Node is down or unresponsive for more than ' + duration + '</p>' +
            '<table style="border: 1px solid #ccc;background-color: #eaeaea">' +
            '<tr>' +
            '<th style="text-align: left">Id</th>' +
            '<td style="text-align: left">' + node.id + '</td>' +
            '</tr>' +
            '<tr>' +
            '<th style="text-align: left">Name</th>' +
            '<td style="text-align: left">' + node.name + '</td>' +
            '</tr>' +
            '<tr>' +
            '<th style="text-align: left">Kong Admin URL</th>' +
            '<td style="text-align: left">' + node.kong_admin_url + '</td>' +
            '</tr>' +
            '</table>';

        return html;
    },

    getMinutesDiff : function(start,end) {
        var duration = moment.duration(moment(start).diff(moment(end)));
        return duration.asMinutes();
    },

    getAdminEmailsList : function(cb) {
        sails.models.user.find({
            admin : true
        }).exec(function(err,admins){
            if(err) return cb(err)
            if(!admins.length) return cb([])
            return cb(null,admins.map(function(item){
                return item.email;
            }))
        })
    }
}
